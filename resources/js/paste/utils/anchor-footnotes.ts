/**
 * Universal footnote detection from internal hyperlinks.
 *
 * The engine used to find footnotes by GUESSING VOCABULARY: a hardcoded list of
 * five anchor names (`ftn`, `fn`, `note`, `_edn`, `_ftn`) with no separator
 * allowed, in `footnote-linker.ts`. A site that named its anchors anything else
 * was invisible. common-wealth.org names them `footnote-N` (prod report
 * book_1787965215968) — not on the list, hyphen not allowed, 54 footnotes lost:
 *
 *     marker      <sup><a href="https://…/us-big-tech…#footnote-1" id="pub-footnote-1">[1]</a></sup>
 *     definition  <p><span id="footnote-1"><a href="https://…#pub-footnote-1">[1]</a></span> note text…</p>
 *
 * This module ignores names entirely and reads STRUCTURE. Every footnote system
 * on the web has the same shape regardless of who generated it: a link in the
 * body points at an element further down, and that element usually points back.
 * The round trip is near-unambiguous — nothing else in an HTML document does it.
 *
 * Covers, without knowing any of their names: common-wealth
 * (`pub-footnote-N` ↔ `footnote-N`), Wikipedia (`cite_ref-N` ↔ `cite_note-N`),
 * Word / Google Docs (`_ftnref1` ↔ `_ftn1`), Pandoc (`fnref1` ↔ `fn1`), MkDocs
 * (`fnref:1` ↔ `fn:1`), Ghost (`footnote-ref-N` ↔ `footnote-N`).
 *
 * ALL-OR-NOTHING. If no cohort clears the gates this returns an empty result and
 * the caller must leave its own state untouched — `GeneralProcessor`'s
 * plain-text bracket-endnote strategy only fires when nothing else claimed a
 * marker, and `generic-bracket-endnotes.html` pins it.
 */

import { MIN_ORDINAL_DENSITY, ordinalDensity } from './reference-detection';
import { isReferenceHeading } from './reference-headings';
import { hasReferenceStructure } from './reference-detection';

/** A cohort this small is a coincidence, not a footnote system. */
const MIN_COHORT = 3;

/** How far above an anchor to look for the id that identifies it (Wikipedia puts it on the parent <sup>). */
const MAX_ID_HOPS = 3;

/** Share of pairs that must agree on direction before we trust it. */
const MIN_DIRECTION_AGREEMENT = 0.9;

/** A definition block shorter than this is a stub, not a note. */
const MIN_DEFINITION_TEXT = 20;

/** Share of definition blocks that must carry real text. */
const MIN_DEFINITION_TEXT_SHARE = 0.8;

/** Tier 2 only: a marker's own text must be short — a long link is prose, not a marker. */
const MAX_MARKER_TEXT = 12;

export interface ResolvedFootnote {
  /** Becomes `footnote.originalIdentifier`, the join key the whole pipeline uses. */
  ordinal: string;
  /** Marker anchors in document order (a note may be cited more than once). */
  markers: Element[];
  /** The block to strip, remove from the body, and re-emit as static content. */
  definitionBlock: Element;
  /** Anchors inside `definitionBlock` that point back at a marker — pruned on apply. */
  backlinks: Element[];
}

export interface AnchorFootnoteResult {
  /** Empty means "not confident" — the caller must change nothing. */
  footnotes: ResolvedFootnote[];
  tier: 'reciprocal' | 'one-way' | null;
  /** Masked fragment shape that won, for diagnostics. */
  shape: string | null;
  /** Why nothing was returned, for diagnostics. */
  rejected: 'no-edges' | 'cohort' | 'density' | 'direction' | 'bibliography' | null;
}

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

const SUPERSCRIPT_DIGITS: Record<string, string> = {
  '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4',
  '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9',
};

/**
 * The number a marker is displaying, whatever decoration it wears.
 *
 * `[1]`, `(1)`, `1.`, `¹`, `*1` and `01` all mean 1. Five places in the engine
 * test `/^\d+$/` on raw marker text and therefore threw away every bracketed
 * marker on the web — that is why common-wealth's `[1]` was rejected.
 * Returns null for a marker with no number (a bare dagger), which correctly
 * falls through to a fragment- or order-derived ordinal.
 */
export function parseMarkerNumber(text: string | null | undefined): string | null {
  if (!text) return null;

  let value = '';
  for (const char of text) {
    value += SUPERSCRIPT_DIGITS[char] ?? char;
  }

  value = value
    .replace(/[\s ]/g, '')
    .replace(/^[[({【]+/, '')
    .replace(/[\])}】]+$/, '')
    .replace(/^[*†‡§¶]+/, '')
    .replace(/[*†‡§¶]+$/, '')
    .replace(/[.):;,]+$/, '');

  if (!/^\d{1,4}$/.test(value)) return null;
  return String(parseInt(value, 10));
}

/**
 * The fragment an href points at, or null.
 *
 * Anchored at the END, never the start, so an ABSOLUTE same-page URL works
 * exactly like a bare `#fragment` — common-wealth writes the full
 * `https://www.common-wealth.org/publications/…#footnote-1`. Allows `:` and `.`
 * because MkDocs emits `fn:1` and some generators emit dotted ids.
 */
export function extractFragment(href: string | null | undefined): string | null {
  if (!href) return null;
  const match = href.match(/#([A-Za-z_][\w:.\-]*)$/);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/**
 * Collapse an id/fragment to its family by masking digit runs:
 * `pub-footnote-12` → `pub-footnote-N`. Two anchors share a shape when they came
 * out of the same generator, which is what makes cohort detection possible
 * without knowing any vocabulary.
 */
export function maskDigits(fragment: string): string {
  return fragment.replace(/\d+/g, 'N');
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface Edge {
  /** The anchor carrying the href. */
  anchor: Element;
  /** The id/name identifying the anchor's own end of the link, if any. */
  sourceId: string | null;
  /** The fragment it points at. */
  targetId: string;
  /** The element that fragment resolves to. */
  target: Element;
}

/** One end of a round trip: the anchor sitting at an id, and the element carrying it. */
interface Endpoint {
  id: string;
  anchor: Element;
  el: Element;
}

/** A round trip, before we know which end is the marker. */
interface RoundTrip {
  a: Endpoint;
  b: Endpoint;
}

/** A round trip after direction has decided. */
interface Pair {
  markerAnchor: Element;
  markerId: string;
  definitionAnchorId: string;
  definitionEl: Element;
}

function textOf(el: Element | null | undefined): string {
  return (el?.textContent || '').replace(/\s+/g, ' ').trim();
}

/**
 * Fragment targets. Includes `a[name]`, which is NOT optional: Word's
 * "Save as Web Page" writes `<a name="_ftn1">` with no id at all, and `name`
 * survives both DOMPurify and the Stage-5 attribute strip.
 *
 * Never resolve these with `querySelector('#' + id)` — MkDocs ids look like
 * `fn:1`, which is invalid CSS and throws. Map lookup only.
 */
function buildTargetMap(root: Element): Map<string, Element> {
  const map = new Map<string, Element>();
  root.querySelectorAll('[id]').forEach((el) => {
    const id = el.getAttribute('id');
    if (id && !map.has(id)) map.set(id, el);
  });
  root.querySelectorAll('a[name]').forEach((el) => {
    const name = el.getAttribute('name');
    if (name && !map.has(name)) map.set(name, el);
  });
  return map;
}

/** The id identifying this anchor's end of a link — on itself, or just above it. */
function identityOf(anchor: Element, root: Element, linkedIds: ReadonlySet<string>): string | null {
  let el: Element | null = anchor;
  let hops = 0;
  while (el && el !== root && hops <= MAX_ID_HOPS) {
    const id = el.getAttribute('id') || el.getAttribute('name');
    if (id && linkedIds.has(id)) return id;
    el = el.parentElement;
    hops += 1;
  }
  return null;
}

/**
 * Is this anchor superscript-adjacent?
 *
 * ADDITIVE ONLY — this may widen what is accepted, never narrow it. A footnote
 * system is identified by its id/fragment structure; `<sup>` is presentation,
 * and plenty of real sites don't use it (progressive.international superscripts
 * with `style="top:-4px"`, Word wraps the number in a styled `<span>`). Its one
 * job here is to let a marker whose text ISN'T a number — a dagger, an icon —
 * still qualify at tier 2. Never gate on its absence.
 *
 * Checks BOTH directions when it does apply: common-wealth wraps its anchor in a
 * `<sup>`, Pandoc puts the `<sup>` inside the anchor.
 */
function supAffinity(anchor: Element): boolean {
  return anchor.closest('sup') !== null || anchor.querySelector('sup') !== null;
}

function blockOf(el: Element, root: Element): Element | null {
  const block = el.closest('p, li, dd, td, blockquote') || el.closest('div, section') || el;
  if (block === root) return null;
  if (/^H[1-6]$/.test(block.tagName)) return null;
  return block;
}

function isBacklink(anchor: Element, markerIds: ReadonlySet<string>): boolean {
  const fragment = extractFragment(anchor.getAttribute('href'));
  return fragment !== null && markerIds.has(fragment);
}

/** Text of a definition block once its back-link is notionally gone. */
function definitionText(block: Element, markerIds: ReadonlySet<string>): number {
  let length = textOf(block).length;
  block.querySelectorAll('a[href]').forEach((a) => {
    if (isBacklink(a, markerIds)) length -= textOf(a).length;
  });
  return length;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Find the document's footnote system, if it has one.
 *
 * @param root - The pasted DOM. Must still carry its ids — this has to run in
 *   `extractFootnotes` (Stage 2), because `cleanup()` (Stage 5) strips every id.
 */
export function resolveAnchorFootnotes(root: Element): AnchorFootnoteResult {
  const empty = (rejected: AnchorFootnoteResult['rejected']): AnchorFootnoteResult =>
    ({ footnotes: [], tier: null, shape: null, rejected });

  const targets = buildTargetMap(root);
  if (targets.size === 0) return empty('no-edges');

  const order = new Map<Element, number>();
  root.querySelectorAll('*').forEach((el, index) => order.set(el, index));
  const positionOf = (el: Element) => order.get(el) ?? -1;

  // Every internal link, plus the set of ids anything actually points at (which
  // is what makes an id an "identity" rather than incidental markup).
  const anchors = Array.from(root.querySelectorAll('a[href]'));
  const linkedIds = new Set<string>();
  anchors.forEach((a) => {
    const fragment = extractFragment(a.getAttribute('href'));
    if (fragment && targets.has(fragment)) linkedIds.add(fragment);
  });
  if (linkedIds.size === 0) return empty('no-edges');

  const edges: Edge[] = [];
  anchors.forEach((anchor) => {
    const targetId = extractFragment(anchor.getAttribute('href'));
    if (!targetId) return;
    const target = targets.get(targetId);
    if (!target || target === anchor) return;
    edges.push({ anchor, targetId, target, sourceId: identityOf(anchor, root, linkedIds) });
  });
  if (edges.length < MIN_COHORT) return empty('no-edges');

  const reciprocal = resolveReciprocal(root, edges, targets, positionOf);
  if (reciprocal) return reciprocal;

  return resolveOneWay(root, edges, positionOf);
}

/**
 * TIER 1 — the round trip. Marker `id=X` → `#Y`, and the element at `Y` links
 * back to `#X`. Nothing but a footnote system does this.
 */
function resolveReciprocal(
  root: Element,
  edges: readonly Edge[],
  targets: ReadonlyMap<string, Element>,
  positionOf: (el: Element) => number,
): AnchorFootnoteResult | null {
  // Index every edge by the identity of the end it starts from.
  const bySource = new Map<string, Edge[]>();
  edges.forEach((edge) => {
    if (!edge.sourceId) return;
    const list = bySource.get(edge.sourceId);
    if (list) list.push(edge);
    else bySource.set(edge.sourceId, [edge]);
  });

  // Group round trips by masked shape. Each trip is recorded ONCE, keyed on its
  // two ids — both of its edges describe the same relationship, and counting
  // both would put half the pairs in each direction and stall the vote at 50%.
  const cohorts = new Map<string, RoundTrip[]>();
  const seen = new Set<string>();

  edges.forEach((edge) => {
    if (!edge.sourceId) return;
    // Does anything at the target point back at us?
    const back = (bySource.get(edge.targetId) || [])
      .find((candidate) => candidate.targetId === edge.sourceId);
    if (!back) return;

    const tripKey = [edge.sourceId, edge.targetId].sort().join(' ');
    if (seen.has(tripKey)) return;
    seen.add(tripKey);

    const here = targets.get(edge.sourceId);
    if (!here) return;

    const key = [maskDigits(edge.sourceId), maskDigits(edge.targetId)].sort().join(' <-> ');
    const trip: RoundTrip = {
      a: { id: edge.sourceId, anchor: edge.anchor, el: here },
      b: { id: edge.targetId, anchor: back.anchor, el: edge.target },
    };
    const list = cohorts.get(key);
    if (list) list.push(trip);
    else cohorts.set(key, [trip]);
  });

  if (cohorts.size === 0) return null;

  // Judge the round trips as ONE SET, not per naming variant.
  //
  // A single generator emits several variants of the same system: MediaWiki
  // writes plain refs as `cite_ref-2 <-> cite_note-2` and named ones as
  // `cite_ref-auto4_1-0 <-> cite_note-auto4-1`, and a note cited twice adds
  // `cite_ref-1-0` / `cite_ref-1-1`. Masked shapes therefore split one sequence
  // into several, and every per-variant threshold then misjudges it: a 21-note
  // article lost its 6 named refs to the density gate (they read 1,3,4,10,11,15
  // = 0.4 in isolation), and a 4-note article can lose its twice-cited note to
  // the cohort-size gate (that variant has one member).
  //
  // Direction is the thing that makes this safe to merge. "Markers are emitted
  // where they are cited, definitions where they are collected" is a property of
  // the DOCUMENT, not of a naming variant — every variant of one generator runs
  // the same way. So the vote is taken over everything at once, and a document
  // containing two genuinely opposed systems fails the 0.9 agreement threshold
  // and is rejected wholesale, which is the safe outcome.
  const allTrips = Array.from(cohorts.values()).flat();
  const shapes = Array.from(cohorts.keys());
  if (allTrips.length < MIN_COHORT) return { footnotes: [], tier: null, shape: null, rejected: 'cohort' };

  const forward = allTrips.filter((t) => positionOf(t.a.anchor) < positionOf(t.b.anchor)).length / allTrips.length;
  const oriented = forward >= MIN_DIRECTION_AGREEMENT
    ? allTrips.map((t) => orient(t.a, t.b))
    : forward <= 1 - MIN_DIRECTION_AGREEMENT
      ? allTrips.map((t) => orient(t.b, t.a))
      : null;
  if (!oriented) return { footnotes: [], tier: null, shape: null, rejected: 'direction' };

  const rejected: AnchorFootnoteResult['rejected'] = null;

  const resolved = buildCohort(root, oriented, positionOf);
  if (!resolved) return { footnotes: [], tier: null, shape: null, rejected: rejected ?? 'density' };

  resolved.sort((a, b) => positionOf(a.definitionBlock) - positionOf(b.definitionBlock));
  return { footnotes: resolved, tier: 'reciprocal', shape: shapes.join(', '), rejected: null };
}

/** Fix a round trip's ends once the cohort vote has said which way it runs. */
function orient(marker: Endpoint, definition: Endpoint): Pair {
  return {
    markerAnchor: marker.anchor,
    markerId: marker.id,
    definitionAnchorId: definition.id,
    definitionEl: definition.el,
  };
}

/**
 * Turn a directed cohort into footnotes, applying the corroborating vetoes.
 * Returns null if the cohort fails any of them.
 */
function buildCohort(
  root: Element,
  pairs: readonly Pair[],
  positionOf: (el: Element) => number,
): ResolvedFootnote[] | null {
  const markerIds = new Set(pairs.map((p) => p.markerId));

  // One definition may serve several markers (a note cited twice), but a marker
  // pointing at two definitions means we misread the structure.
  const byDefinition = new Map<Element, Pair[]>();
  for (const pair of pairs) {
    const block = blockOf(pair.definitionEl, root);
    if (!block) return null;
    const list = byDefinition.get(block);
    if (list) list.push(pair);
    else byDefinition.set(block, [pair]);
  }
  if (byDefinition.size < MIN_COHORT) return null;

  // Two definitions sharing one block means the block boundary is wrong.
  const blocks = Array.from(byDefinition.keys());
  for (const block of blocks) {
    if (blocks.some((other) => other !== block && block.contains(other))) return null;
  }

  // NO <sup> TEST HERE, deliberately. <sup> is presentation, and this is a
  // structural resolver: the round trip plus the direction vote have already
  // established which end is which, so a superscript check can only ever turn a
  // correct answer into a rejection. Real sites superscript with CSS
  // (progressive.international uses `style="top:-4px"`), put the <sup> inside
  // the anchor (Pandoc) or omit it entirely, and a note's own text can contain
  // one. Where <sup> IS present it is used additively — see the tier-2 marker
  // test, which accepts a superscripted marker whose text is not a number.

  // VETO: definitions must actually carry note text.
  const substantial = blocks.filter((b) => definitionText(b, markerIds) >= MIN_DEFINITION_TEXT).length;
  if (substantial / blocks.length < MIN_DEFINITION_TEXT_SHARE) return null;

  // Ordinals: marker text, then either fragment, then document order.
  const entries = Array.from(byDefinition.entries())
    .sort(([a], [b]) => positionOf(a) - positionOf(b));

  const parsed = entries.map(([, group]) => {
    const first = group[0];
    if (!first) return null;
    return parseMarkerNumber(textOf(first.markerAnchor))
      ?? lastDigits(first.markerId)
      ?? lastDigits(first.definitionAnchorId);
  });

  const usable = parsed.every((value) => value !== null)
    && new Set(parsed).size === parsed.length;
  const ordinals = usable
    ? parsed.map((value) => value as string)
    : entries.map((_entry, index) => String(index + 1));

  // DENSITY: a real numbered system fills its span. Scattered numbers are
  // something else that happens to be linked.
  if (ordinalDensity(ordinals.map((n) => parseInt(n, 10))) < MIN_ORDINAL_DENSITY) return null;

  return entries.map(([block, group], index) => {
    const markers = new Set(group.map((p) => p.markerAnchor));

    // SWEEP for repeat citations. A note cited twice often gets a back-link to
    // only its FIRST marker, so the second marker has no round trip and never
    // joined a cohort. Once the definition is confirmed, any other anchor
    // pointing at it is a marker for it too — no further evidence needed.
    const definitionId = group[0]?.definitionAnchorId;
    if (definitionId) {
      root.querySelectorAll('a[href]').forEach((anchor) => {
        if (markers.has(anchor) || block.contains(anchor)) return;
        if (extractFragment(anchor.getAttribute('href')) === definitionId) markers.add(anchor);
      });
    }

    return {
      ordinal: ordinals[index] ?? String(index + 1),
      markers: Array.from(markers).sort((a, b) => positionOf(a) - positionOf(b)),
      definitionBlock: block,
      backlinks: Array.from(block.querySelectorAll('a[href]')).filter((a) => isBacklink(a, markerIds)),
    };
  });
}

function lastDigits(value: string | null | undefined): string | null {
  const match = (value || '').match(/(\d+)(?!.*\d)/);
  return match?.[1] ? String(parseInt(match[1], 10)) : null;
}

/**
 * TIER 2 — marker → definition with no back-link. Much weaker evidence, so
 * every gate must pass, including deferring to a bibliography: a numeric
 * citation list under a "References" heading has exactly this shape and belongs
 * to the reference extractor, not here.
 */
function resolveOneWay(
  root: Element,
  edges: readonly Edge[],
  positionOf: (el: Element) => number,
): AnchorFootnoteResult {
  const empty = (rejected: AnchorFootnoteResult['rejected']): AnchorFootnoteResult =>
    ({ footnotes: [], tier: null, shape: null, rejected });

  const cohorts = new Map<string, Edge[]>();
  edges.forEach((edge) => {
    const key = maskDigits(edge.targetId);
    const list = cohorts.get(key);
    if (list) list.push(edge);
    else cohorts.set(key, [edge]);
  });

  let best: { shape: string; footnotes: ResolvedFootnote[] } | null = null;
  let rejected: AnchorFootnoteResult['rejected'] = 'cohort';

  for (const [shape, group] of cohorts) {
    if (group.length < MIN_COHORT) continue;

    // Every marker precedes its definition, no exceptions at this tier.
    if (!group.every((e) => positionOf(e.anchor) < positionOf(e.target))) { rejected = 'direction'; continue; }

    // A marker is short, and carries a number — decorated ("[1]"), superscript,
    // or bare. A BARE number was once rejected here as too weak, on the grounds
    // that a lone `1` proves nothing. True of one link; false of a cohort. Real
    // sites superscript their markers with CSS rather than <sup>
    // (progressive.international emits `<a href="…#ref-1" style="top:-4px">1</a>`
    // and lost all 19 of its notes to this rule). The evidence lives in the
    // cohort — a dense ascending run of numbers pointing into substantial
    // tail-clustered blocks — and every one of those gates is still below. A
    // numbered table of contents does not pass them, because its targets are
    // headings, which blockOf rejects.
    const markersLookRight = group.every((e) => {
      const text = textOf(e.anchor);
      if (text.length > MAX_MARKER_TEXT) return false;
      return supAffinity(e.anchor) || parseMarkerNumber(text) !== null;
    });
    if (!markersLookRight) { rejected = 'direction'; continue; }

    const byDefinition = new Map<Element, Edge[]>();
    for (const edge of group) {
      const block = blockOf(edge.target, root);
      if (!block) { continue; }
      const list = byDefinition.get(block);
      if (list) list.push(edge);
      else byDefinition.set(block, [edge]);
    }
    if (byDefinition.size < MIN_COHORT) { rejected = 'cohort'; continue; }

    const blocks = Array.from(byDefinition.keys());
    if (!blocks.every((b) => textOf(b).length >= MIN_DEFINITION_TEXT)) { rejected = 'cohort'; continue; }

    // Definitions must sit together — tail-clustered, or all in one container.
    const positions = blocks.map(positionOf).sort((a, b) => a - b);
    const median = positions[Math.floor(positions.length / 2)] ?? 0;
    const allPositions = group.map((e) => positionOf(e.anchor)).concat(positions).sort((a, b) => a - b);
    const overallMedian = allPositions[Math.floor(allPositions.length / 2)] ?? 0;
    const oneParent = new Set(blocks.map((b) => b.parentElement)).size === 1;
    if (!oneParent && median <= overallMedian) { rejected = 'direction'; continue; }

    // BIBLIOGRAPHY DEFERRAL: this shape is also what a numeric citation list
    // under a References heading looks like, and that belongs to the reference
    // extractor.
    if (looksLikeBibliography(root, blocks)) { rejected = 'bibliography'; continue; }

    const entries = Array.from(byDefinition.entries()).sort(([a], [b]) => positionOf(a) - positionOf(b));
    const parsed = entries.map(([, g]) => {
      const first = g[0];
      return first ? parseMarkerNumber(textOf(first.anchor)) ?? lastDigits(first.targetId) : null;
    });
    const usable = parsed.every((v) => v !== null) && new Set(parsed).size === parsed.length;
    const ordinals = usable ? parsed.map((v) => v as string) : entries.map((_e, i) => String(i + 1));

    const nums = ordinals.map((n) => parseInt(n, 10));
    if (ordinalDensity(nums) < MIN_ORDINAL_DENSITY) { rejected = 'density'; continue; }
    // A real note list starts at the beginning.
    if (Math.min(...nums) > 2) { rejected = 'density'; continue; }

    const footnotes = entries.map(([block, g], index) => ({
      ordinal: ordinals[index] ?? String(index + 1),
      markers: g.map((e) => e.anchor).sort((a, b) => positionOf(a) - positionOf(b)),
      definitionBlock: block,
      backlinks: [] as Element[],
    }));

    if (!best || footnotes.length > best.footnotes.length) best = { shape, footnotes };
  }

  if (!best) return empty(rejected);
  return { footnotes: best.footnotes, tier: 'one-way', shape: best.shape, rejected: null };
}

/**
 * True when these blocks are really a reference list rather than notes.
 *
 * The heading alone cannot decide this. "References" heads BOTH an author-date
 * bibliography and a numeric note list — progressive.international puts Chicago
 * notes ("Bret Benjamin, 'Bookend to Bandung,' Humanity 6, no. 1 (2015), 44.")
 * under exactly that word, and deferring on the heading alone silently dropped
 * all 19. So the ENTRIES have to corroborate: a bibliography entry leads with
 * "Surname, Forename", a Chicago note leads with a forename or with "See…".
 * A heading lowers the bar for that evidence; it never substitutes for it.
 */
function looksLikeBibliography(root: Element, blocks: readonly Element[]): boolean {
  if (blocks.length === 0) return false;

  const structured = blocks.filter((b) => hasReferenceStructure(textOf(b))).length / blocks.length;
  if (structured >= 0.6) return true;

  const heading = Array.from(root.querySelectorAll('h1, h2, h3, h4, h5, h6'))
    .find((h) => isReferenceHeading(h.textContent));
  if (!heading) return false;

  const after = blocks.filter((b) =>
    Boolean(heading.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)).length / blocks.length;

  return after >= 0.5 && structured >= 0.3;
}

// ---------------------------------------------------------------------------
// Applying the result
// ---------------------------------------------------------------------------

/** Leftovers a back-link leaves behind: Wikipedia's "^", Pandoc's "↩", empty spans. */
const RESIDUE_RE = /^[\s ^↩↑←↩↰[\](){}.,;:•·|-]*$/;

/**
 * Rewrite the markers into the engine's canonical pre-link shape and prune the
 * back-links out of the note text.
 *
 * The marker becomes `<sup fn-count-id="N">N</sup>` with NO id and NO class —
 * exactly what `substack-processor.ts` already emits, and what
 * `footnote-linker.ts`'s existing text-match branch completes at Stage 7.
 * `fn-count-id` survives the Stage-5 attribute strip and is allow-listed in
 * `sanitizeConfig`, so no linker change is needed to make this stick.
 */
export function applyAnchorFootnotes(
  resolved: readonly ResolvedFootnote[],
  doc: Document = document,
): void {
  resolved.forEach((footnote) => {
    footnote.markers.forEach((anchor) => {
      const sup = doc.createElement('sup');
      sup.setAttribute('fn-count-id', footnote.ordinal);
      sup.textContent = footnote.ordinal;

      // Replace the wrapping <sup> when the anchor is its only content,
      // otherwise replace the anchor — that is what prevents <sup><sup>.
      const parent = anchor.parentElement;
      const wrapping = parent
        && parent.tagName === 'SUP'
        && parent.children.length === 1
        && parent.children[0] === anchor;

      (wrapping ? parent : anchor).replaceWith(sup);
    });

    footnote.backlinks.forEach((link) => {
      let ancestor: Element | null = link.parentElement;
      link.remove();
      // Walk up removing husks the back-link left behind, but never past the
      // definition block itself.
      while (
        ancestor
        && ancestor !== footnote.definitionBlock
        && footnote.definitionBlock.contains(ancestor)
        && ancestor.children.length === 0
        && RESIDUE_RE.test(ancestor.textContent || '')
      ) {
        const next: Element | null = ancestor.parentElement;
        ancestor.remove();
        ancestor = next;
      }
    });
  });
}
