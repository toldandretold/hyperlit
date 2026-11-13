/**
 * The article-list filter predicates, as pure functions.
 *
 * A zero-import leaf so they can be tested without standing up the console page — and because the
 * distinction they encode is subtle enough to have already been got wrong once.
 */

/** Just enough of a lane for the filters to judge it. */
export interface FilterableLane {
  has_nodes: boolean;
  metadata_drift?: { needs_decision: boolean } | null;
}

export interface FilterableArticle {
  lanes: FilterableLane[];
}

/**
 * Has this work been attempted at all?
 *
 * A work nobody has tried carries no lane rows, because a lane row IS the record of an attempt.
 */
export function isAttempted(article: FilterableArticle): boolean {
  return article.lanes.length > 0;
}

/**
 * Did this work FAIL — i.e. was it attempted and end up with no usable version anywhere?
 *
 * Deliberately "no lane has content", NOT "some lane has no content". Those were the same thing
 * back when a work carried one lane, and the cheaper test shipped. The html-first strategy broke
 * it: that mode tries the free publisher page per work and falls back to the PDF, so every work
 * whose HTML lane failed and whose PDF lane then SUCCEEDED keeps a permanent empty `journal_html`
 * stub (HtmlLaneCreator mints the row before it fetches, so a fetch_failed still persists it)
 * sitting beside a perfectly good pdf lane. On the tripleC run that landed 944 of 960 works, the
 * old predicate matched most of the journal — every successful fallback looked like a failure.
 */
export function isFailed(article: FilterableArticle): boolean {
  return isAttempted(article) && !article.lanes.some((lane) => lane.has_nodes);
}

/**
 * Does this work carry an open metadata-drift flag — the publisher's page disagreeing with the
 * citation data we stored?
 *
 * Sorts DECISIONS FIRST. The flag covers two different things: a dispute the machine refused to
 * settle (both years plausible, someone has to choose) and an audit record of a correction it
 * did make. Only the first is work. A journal-wide repair can leave a thousand of the second, so
 * a filter that treated them alike would bury the handful that actually need a person — which is
 * the same "you hunt 100+ rows for the handful a run reported" problem `isFailed` exists for.
 */
export function hasMetadataDrift(article: FilterableArticle): boolean {
  return article.lanes.some((lane) => !!lane.metadata_drift);
}

/** Only works where a maintainer still has to choose between two plausible values. */
export function needsMetadataDecision(article: FilterableArticle): boolean {
  return article.lanes.some((lane) => lane.metadata_drift?.needs_decision === true);
}
