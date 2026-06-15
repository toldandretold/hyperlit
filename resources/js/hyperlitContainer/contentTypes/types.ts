/**
 * ContentTypeHandler — one per content type the hyperlit container can show
 * (footnote / citation / hyperlight / hypercite / hypercite-citation). Each handler
 * owns that type's priority, optional creation-timestamp fetch, content build (delegating
 * to the contentBuilders render layer), optional post-open behaviour, and optional
 * edit-permission check. The thin orchestrators (contentBuild / postOpen / permissions)
 * loop the registry instead of switching on `type`.
 */

/** Context for buildContent — the per-open data the render layer needs. */
export interface BuildCtx {
  db: any;
  editModeEnabled: boolean;
  newHighlightIds: any[];
}

/** Context for postOpen — threaded across handlers; subBookEditor is shared+mutable. */
export interface PostOpenCtx {
  newHighlightIds: any[];
  focusPreserver: any;
  skipAutoFocus: boolean;
  isNewFootnote: boolean;
  db: any;
  editModeEnabled: boolean;
  options: any;
  /** Shared latch: only the first user-owned sub-book gets the divEditor attached. */
  subBookEditor: { attached: boolean };
}

/** Context for checkPermission — the resolved auth identity + open data. */
export interface PermissionCtx {
  newHighlightIds: any[];
  db: any;
  currentUser: any;
  currentUserId: any;
}

export interface ContentTypeHandler {
  /** The content-type tag (matches detection's `ct.type`). */
  type: string;
  /** Lower = built/shown first. hypercite-citation 1 → footnote 2 → citation 3 → hypercite 4 → highlight 5. */
  priority: number;
  /** Creation timestamp for chronological sort within equal priority (highlight/hypercite only). */
  fetchTimestamp?(ct: any, db: any): Promise<number>;
  /** Build this type's HTML section (delegates to contentBuilders/display*). */
  buildContent(ct: any, ctx: BuildCtx): Promise<string>;
  /** Per-type post-open behaviour (sub-book loading, listeners, focus). */
  postOpen?(ct: any, ctx: PostOpenCtx): Promise<void>;
  /** Whether the user may edit this item (drives whether the edit button shows). */
  checkPermission?(ct: any, ctx: PermissionCtx): Promise<boolean>;
}
