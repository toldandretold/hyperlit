/**
 * /maintainer/study — citation-study reviewer-review workbench.
 *
 * Three panes: claims list (flagged verdicts by default), claim detail with the
 * two-axis adjudication form (ground-truth label + failure cause), and the
 * source PDF with server-side text search (click a hit → iframe jumps via
 * #page=N). All rendering is pure DOM construction — never innerHTML — per the
 * maintainer-console house rule; the one exception-shaped need (bib_citation
 * arrives as HTML with <em> tags) is handled by stripping tags to text.
 */

import { confirmDialog } from '../../components/dialog/dialog';
import { log } from '../../utilities/logger';
import { drainResponse } from '../../utilities/drainResponse';
import {
  api,
  EVIDENCE_MAX_CHARS,
  type Adjudication,
  type BookPayload,
  type BookSummary,
  type ClaimRow,
  type PathStep,
  type PathWork,
} from './api';
import { REFERENCES, REFERENCE_ERRORS, SCORING, deriveLabel, isRealReference } from './verdictAxes';

const FLAGGED = new Set(['rejected', 'unlikely', 'source_not_found', 'insufficient']);

/** Evidence = what the REVIEWER read that settles THEIR verdict — "from the source" is only
 *  the common case; a fabricated-reference verdict quotes counter-evidence instead (the form
 *  swaps this wording when question 1 is answered "fabricated", see applyReferenceCopy). */
const EVIDENCE_PLACEHOLDER_DEFAULT =
  'Quotes from the source that back this verdict — one per paragraph. Select text in the pane and press "use selection", or paste.';

// The reviewer's two questions (is the work real / does it support the claim) and the label
// derived from them live in ./verdictAxes. What follows is the separate, optional CAUSE:
// when the AI flagged this citation, whose failure was it? Feeds system
// improvement (dataset.csv human_cause), never the label.
const CAUSES: Array<{ value: string; text: string; desc: string }> = [
  { value: 'correct_flag', text: 'correct flag — citation genuinely bad',
    desc: 'The AI was right to flag this citation.' },
  { value: 'resolver_gap', text: 'resolver gap — source exists, we missed it',
    desc: 'The source is real and findable; our resolver failed to find it. Fixable on our side.' },
  { value: 'conversion_mangled', text: 'conversion mangled — our OCR',
    desc: 'Our PDF conversion corrupted the citation text before the AI ever saw it. Check the Conversion check block.' },
  { value: 'claim_scoping', text: 'claim scoping — wrong sentence/slice attributed',
    desc: 'Our extractor attributed text this citation was never meant to support: a slice of a grouped citation (A; B; C), or an adjacent UNCITED sentence grabbed instead of the cited one. The citation is fine; the verifier honestly reported the mismatch.' },
  { value: 'citation_mislink', text: 'citation mislink — our linker minted/misdirected the anchor',
    desc: "The author never made this claim-source pairing: our in-text linker turned a bare year (or year range) into a citation, or pointed a real citation at the wrong entry. The AI honestly reviewed a pairing that doesn't exist." },
  { value: 'evidence_truncated', text: 'evidence truncated — our snapshot clipped it',
    desc: 'The source was correctly resolved, but the supporting text lies beyond what we stored (e.g. the web-fetch character cap). You found the evidence in the full source; the AI never saw it.' },
  { value: 'grey_literature', text: 'grey literature — legitimately unindexed',
    desc: "A real source that no index carries (internal reports, Hansard, legislation). Nobody's failure." },
  { value: 'citation_typo', text: 'citation typo — minor error defeated matching',
    desc: 'A small slip in the citation (a missing or wrong word in the title, an off-by-one year or page) likely broke OUR exact matching. This is about why our resolver missed it. A citation that names the wrong author, title, year or venue is recorded in question 1 as "real — but cited wrongly".' },
  { value: 'access_blocked', text: 'access blocked — paywall / bot wall',
    desc: 'The cited URL exists but refused our fetcher (401/403/429, or a subscribe-wall). NOT a dead link — verify the article in your browser; this cause records why our system could not see it.' },
  { value: 'dead_link', text: 'dead link — cited URL rotted',
    desc: 'The URL the author printed is genuinely gone (404/410, or a soft-404 page served as 200) — use Check link to confirm. The work may exist elsewhere; if you find a live copy, put it in the found-URL field.' },
  { value: 'other', text: 'other (note)',
    desc: 'None of the above — explain in the note.' },
];

/**
 * The causes that are POSSIBLE for this claim, given what actually happened to it.
 *
 * All eleven chips were shown on every claim, so most were nonsense for the one in front of you:
 * "access blocked" and "dead link" on a claim whose source we resolved and read; "resolver gap" on
 * a claim we resolved; "evidence truncated" on a claim where no evidence was retrieved at all.
 * Choosing a cause that contradicts the record is not a harmless slip — the cause column is what
 * separates "the AI was right" from "our pipeline failed", which is the study's main result.
 *
 * NOT a hard filter: the rest stay available behind a toggle, because a reviewer who has actually
 * read the source can know something the record does not show. Narrowing the default is the point;
 * forbidding the unusual answer would be worse than the wall of chips.
 */
function relevantCauses(claim: ClaimRow): Set<string> {
  const resolved = claim.source?.found === true;
  const evidence = claim.source?.evidence_type ?? 'none';
  const hadEvidence = resolved && evidence !== 'none';
  const support = claim.llm_verdict?.support ?? null;
  const flagged = support === 'unlikely' || support === 'rejected';

  // Always available: our linker can mint a pairing the author never made, our conversion can
  // mangle the text, and "other" is the escape hatch — none of those depend on resolution.
  const causes = new Set(['citation_mislink', 'conversion_mangled', 'other']);

  if (!resolved) {
    // Nothing was found. The question is WHY not — that is a resolution story, never a
    // judgement about whether the source supports the claim.
    ['resolver_gap', 'grey_literature', 'dead_link', 'access_blocked', 'citation_typo', 'correct_flag']
      .forEach((c) => causes.add(c));
    return causes;
  }

  // Resolved: "we could not find it" causes are off the table.
  if (hadEvidence) {
    causes.add('evidence_truncated'); // we had SOME evidence, so it can have been clipped
    causes.add('claim_scoping');      // and the claim we judged it against can be mis-scoped
  } else {
    // Resolved but nothing readable came back — that is an access story.
    causes.add('access_blocked');
    causes.add('evidence_truncated');
  }
  if (flagged) {
    causes.add('correct_flag');       // only meaningful when the AI actually flagged something
    causes.add('claim_scoping');
  }
  return causes;
}

/**
 * Question 2 — WHAT does the cited work actually support? Asked only when question 1 says the
 * work is real.
 *
 * The support scale has no fixed DENOMINATOR, so a verdict alone is ambiguous: "unlikely" means
 * both "supports none of this" and "supports exactly the part it was cited for, and nothing else".
 * Recording which makes the ground truth independent of the verify prompt a run used, so the SAME
 * answers score both variants (services.citation_review.verify_scope). A fragment_only claim SHOULD
 * read unsupported under the strict prompt and supported under the fragment prompt — both correct.
 *
 * Distinct from the claim_scoping CAUSE: that is OUR extractor grabbing the wrong text; this is the
 * extraction being right and the citation simply backing one part of it.
 */
const SUPPORTED_SCOPES: Array<{ value: string; text: string; desc: string }> = [
  { value: 'whole_claim', text: 'supports the whole claim',
    desc: 'The source supports the claim sentence as a whole — no scope caveat.' },
  { value: 'fragment_only', text: 'supports PART of the claim',
    desc: 'The source supports one component of the sentence but not the rest, and was cited for that component. Say WHICH part in the note — that is the ground truth. Example: "…a Special Issue commemorating the fiftieth anniversary of the campaign for a NIEO (UN 1974a)" — the 1974 Declaration evidences the campaign, not the Special Issue.' },
  { value: 'none', text: 'supports none of it',
    desc: 'The work is real but supports no part of the claim.' },
  { value: 'undetermined', text: "can't tell without the source",
    desc: 'The work is real, but it was blocked, dead or not retrieved — you could not read enough to judge. Not scored.' },
];

/**
 * Did the resolver land on the RIGHT WORK? Mirrors AdjudicationStore::SOURCE_MATCHES.
 * Separate from the reviewer's two answers and from the AI verdict, because the AI can say "likely" after reading the WRONG
 * source: a citation with no printed URL is resolved by web search, and a page on the same topic can
 * carry a true claim. Recorded per row and tallied per match_method, it gives each resolution
 * method a precision (MetricsCalculator::resolutionAccuracy). Offered only when something resolved.
 */
const SOURCE_MATCHES: Array<{ value: string; text: string; desc: string }> = [
  { value: 'same_work', text: 'right URL',
    desc: 'The URL/source we found IS the cited work (any edition or copy).' },
  { value: 'different_work', text: 'wrong URL',
    desc: 'The URL we found is some other page — even a related one, and even if the AI verdict came out right. '
      + 'Put the right URL in the verdict form’s found-URL field.' },
];

/** A URL reduced to host + path, so http/https, www. and a trailing slash don't read as different. */
function urlKey(u: string): string {
  return u.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[#?].*$/, '').replace(/\/+$/, '');
}

/**
 * Did OUR SYSTEM supply the source URL? True when we have a URL and the citation did not print
 * that one. That is the whole rule for asking "is this the right URL?": a printed URL is the
 * author's pointer, so if it leads elsewhere that is the citation's problem (the label) or our
 * fetch's (the extraction flag's "A different article"); a URL we found ourselves is our call.
 */
function systemSuppliedUrl(claim: ClaimRow): string | null {
  const found = claim.source?.url ?? null;
  if (!claim.source?.found || !found) return null;
  const printed = claim.llm_metadata?.['url'];
  if (typeof printed === 'string' && printed.trim() !== '' && urlKey(printed) === urlKey(found)) return null;
  return found;
}

/**
 * "Is the URL we found the right one?" answered BEFORE a verdict exists, keyed by claim key.
 * A label-less adjudication would break the consumers that read ['label'], so the answer waits
 * here and rides along with the verdict's save.
 */
const pendingSourceMatch = new Map<string, string | null>();

/**
 * The right URL / wrong URL buttons, under the URL in the Resolved Source panel — beside the
 * thing they ask about. Only when OUR SYSTEM supplied the URL (systemSuppliedUrl). With a saved
 * verdict a click saves straight onto it; without one it is held for the verdict.
 */
function sourceMatchWidget(claim: ClaimRow): HTMLElement | null {
  if (!systemSuppliedUrl(claim)) return null;
  // Loud until answered: a verdict reasoned from a URL nobody confirmed is the cited work is
  // the failure this question exists for, and it went unnoticed while the question was quiet.
  const row = el('div', 'st-flag-row st-urlcheck');
  row.append(el('span', 'st-urlcheck-q', 'We found this URL — is it right?'));
  const status = el('span', 'st-flag-status');
  const current = (): string | null =>
    claim.adjudication ? (claim.adjudication.source_match ?? null) : (pendingSourceMatch.get(claim.key) ?? null);

  const buttons = SOURCE_MATCHES.map((sm) => {
    const b = el('button', 'st-undo', sm.text) as HTMLButtonElement;
    b.type = 'button';
    b.title = sm.desc;
    b.addEventListener('click', () => {
      void (async () => {
        const next = current() === sm.value ? null : sm.value;
        if (!claim.adjudication) {
          pendingSourceMatch.set(claim.key, next);
          paint();
          status.textContent = next ? 'saved with your verdict' : '';
          return;
        }
        if (!state.slug) return;
        buttons.forEach((x) => { x.disabled = true; });
        const { status: code, data } = await api.putSourceMatch(state.corpus, state.slug, { key: claim.key, source_match: next });
        buttons.forEach((x) => { x.disabled = false; });
        if (code !== 200 || !data.ok || !data.adjudication) {
          status.textContent = data.error ?? `Save failed (${code})`;
          log.error(`source-match save failed: ${data.error ?? code}`, '/workbenches/study/main.ts');
          return;
        }
        claim.adjudication = data.adjudication;
        paint();
        status.textContent = 'saved';
        renderList(); // the row's "URL unchecked" badge (and the filter) follow the answer
      })();
    });
    return b;
  });
  const paint = (): void => {
    const cur = current();
    buttons.forEach((b, i) => b.classList.toggle('st-choice-on', SOURCE_MATCHES[i]?.value === cur));
    row.classList.toggle('st-urlcheck-pending', cur === null);
    row.classList.toggle('st-urlcheck-wrong', cur === 'different_work');
  };
  paint();
  row.append(...buttons, status);
  return row;
}


/** A workbench URL that SURVIVES a refresh — the corpus must ride in the query string. */
function studyUrl(slug: string | null, corpus?: string, citationKey?: string | null): string {
  const c = corpus ?? state.corpus;
  const base = slug ? `/maintainer/study/${encodeURIComponent(slug)}` : '/maintainer/study';
  // The selected citation rides the URL so a refresh (or a post-rerun reload)
  // lands back on the claim being reviewed instead of the empty list.
  const citation = citationKey ? `&citation=${encodeURIComponent(citationKey)}` : '';
  return `${base}?corpus=${encodeURIComponent(c)}${citation}`;
}

interface State {
  corpus: string;
  slug: string | null;
  payload: BookPayload | null;
  selectedKey: string | null;
  filterFlagged: boolean;
  filterUnadjudicated: boolean;
  filterNeedsEvidence: boolean;
  filterUrlUnchecked: boolean;
}

const boot = (window as unknown as { __study?: { corpus?: string; slug?: string | null } })
  .__study ?? {};
const state: State = {
  corpus: boot.corpus || 'phase1',
  slug: boot.slug || null,
  payload: null,
  selectedKey: null,
  filterFlagged: true,
  filterUnadjudicated: false,
  filterNeedsEvidence: false,
  filterUrlUnchecked: false,
};

// ---------------------------------------------------------------- helpers

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** bib_citation arrives as stored HTML (<em> etc); render as plain text. */
function htmlToText(html: string): string {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  return tpl.content.textContent ?? '';
}

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} missing`);
  return node as T;
}

function flash(parent: HTMLElement, message: string): void {
  const p = el('p', 'st-error', message);
  parent.prepend(p);
  setTimeout(() => p.remove(), 4000);
}

// ---------------------------------------------------------------- book list

async function loadBooks(): Promise<void> {
  const root = byId<HTMLDivElement>('st-books');
  try {
    const summary = await api.books(state.corpus);
    root.replaceChildren(...summary.books.map((b) => bookRow(b)));
    const counts = byId<HTMLSpanElement>('st-counts');
    const flagged = summary.books.reduce((n, b) => n + b.counts.flagged, 0);
    const adjudicated = summary.books.reduce((n, b) => n + b.counts.adjudicated, 0);
    counts.textContent = `${summary.corpus}${summary.frozen ? ' (frozen)' : ''} — ${flagged} flagged, ${adjudicated} adjudicated`;
  } catch (e) {
    root.replaceChildren(el('p', 'st-empty', 'Failed to load — are you signed in as an admin?'));
    log.error(`study books load failed: ${String(e)}`, '/workbenches/study/main.ts');
  }
}

function bookRow(book: BookSummary): HTMLElement {
  const row = el('button', 'st-book');
  row.type = 'button';
  if (book.slug === state.slug) row.classList.add('st-book-active');
  row.append(
    el('span', 'st-book-title', book.title),
    el(
      'span',
      'st-book-meta',
      // PATHWAY first: in a multi-pathway corpus the same work appears four times under an
      // identical title and every one is arm 'control', so the arm alone made the rows
      // indistinguishable. Show the arm only when it says something (a corrupted/retracted arm).
      `${book.pathway ? book.pathway.toUpperCase() : (book.arm ?? '')}${book.arm && book.arm !== 'control' ? ` · ${book.arm}` : ''} · ${book.run_status === 'completed' ? `${book.counts.flagged}/${book.counts.total} flagged · ${book.counts.adjudicated} done` : book.run_status}`,
    ),
  );
  row.addEventListener('click', () => {
    state.slug = book.slug;
    state.selectedKey = null;
    // KEEP the corpus in the URL. Dropping it meant every refresh fell back to
    // config('study.default_corpus') — phase1 — so working in phase2 and reloading silently threw
    // you into a different corpus, with Back unable to undo it because this is a replaceState.
    history.replaceState(null, '', studyUrl(book.slug));
    void loadBook();
    void loadBooks();
  });
  return row;
}

// ---------------------------------------------------------------- claims list

/**
 * "Needs evidence" = NOTHING is quoted behind this row yet: an adjudicated
 * verdict missing its quotes ('owed'), OR a row with no verdict at all — the
 * evidence work there is still to come, verdict included. Excluded: quoted,
 * inherited, and adjudicated non-scored labels (nothing to quote).
 */
function needsEvidence(c: ClaimRow): boolean {
  return evidenceState(c) === 'owed' || !c.adjudication;
}

/**
 * "URL unchecked" = a saved verdict on a row whose URL OUR SYSTEM supplied, with the
 * right-URL/wrong-URL question never answered. The backlog from before the question existed:
 * every such verdict was reasoned from a URL nobody confirmed was the cited work.
 */
function urlUnchecked(c: ClaimRow): boolean {
  return !!c.adjudication && systemSuppliedUrl(c) !== null && !c.adjudication.source_match;
}

function matchesFilters(c: ClaimRow): boolean {
  if (state.filterFlagged && !FLAGGED.has(c.verdict)) return false;
  if (state.filterUnadjudicated && c.adjudication) return false;
  if (state.filterNeedsEvidence && !needsEvidence(c)) return false;
  if (state.filterUrlUnchecked && !urlUnchecked(c)) return false;
  return true;
}

function visibleClaims(): ClaimRow[] {
  const payload = state.payload;
  if (!payload) return [];
  // The SELECTED claim is always listed, filters or no: re-running/adjudicating
  // the claim under review routinely changes it to a state the active filters
  // exclude ("flagged only" + a verdict that just improved to likely), and
  // having the thing being worked on vanish mid-review was worse than one
  // exception row. It drops out naturally when another claim is selected.
  return payload.claims.filter((c) => matchesFilters(c) || c.key === state.selectedKey);
}

async function loadBook(): Promise<void> {
  const list = byId<HTMLDivElement>('st-list');
  if (!state.slug) {
    list.replaceChildren(el('p', 'st-empty', 'Pick a book above.'));
    return;
  }
  list.replaceChildren(el('p', 'st-empty', 'Loading…'));
  try {
    state.payload = await api.claims(state.corpus, state.slug);
  } catch (e) {
    list.replaceChildren(el('p', 'st-empty', 'Failed to load claims.'));
    log.error(`study claims load failed: ${String(e)}`, '/workbenches/study/main.ts');
    return;
  }
  byId('st-filters').hidden = false;
  renderList();
  renderApplyBar();
  setupPdfPane();
  if (state.payload.run_status !== 'completed') {
    list.replaceChildren(
      el('p', 'st-empty', `Not run yet (status: ${state.payload.run_status}). Run citation:study:run first.`),
    );
    return;
  }
  restoreSelectionFromUrl();
}

function renderList(): void {
  const list = byId<HTMLDivElement>('st-list');
  const claims = visibleClaims();
  if (claims.length === 0) {
    list.replaceChildren(el('p', 'st-empty', emptyListReason()));
    return;
  }
  list.replaceChildren(...claims.map((c) => claimRow(c)));
}

/**
 * The filters compose (AND), and "flagged only" is ON by default — so an
 * evidence sweep can come back empty while unquoted verdicts sit one unticked
 * box away. Say so: a bare "no claims match" reads as "the backlog is clear",
 * which is the opposite of the truth.
 */
function emptyListReason(): string {
  const all = state.payload?.claims ?? [];
  if (state.filterUrlUnchecked) {
    const n = all.filter(urlUnchecked).length;
    if (n > 0) return `No claims match — ${n} verdict(s) with an unchecked URL are hidden by the other filters.`;
    if (!state.filterNeedsEvidence) return 'Every verdict on a URL we found has had the URL checked. ✓';
  }
  if (state.filterNeedsEvidence) {
    const bare = all.filter(needsEvidence).length;
    if (bare > 0) {
      return `No claims match — ${bare} row(s) need evidence but are hidden by the other filters.`;
    }
    return 'Every row is covered: quoted, evidenced by inheritance, or a non-scored label. ✓';
  }
  return 'No claims match the filter.';
}

function claimRow(claim: ClaimRow): HTMLElement {
  const row = el('button', 'st-claim');
  row.type = 'button';
  row.setAttribute('role', 'listitem');
  if (claim.key === state.selectedKey) row.classList.add('st-claim-active');

  const marker = claim.gt?.footnote_marker ? `fn${claim.gt.footnote_marker}` : (claim.citation_row ?? '');
  const head = el('span', 'st-claim-head');
  head.append(
    el('span', 'st-claim-marker', marker),
    el('span', `st-badge st-verdict-${claim.verdict}`, claim.verdict.replace(/_/g, ' ')),
  );
  const triage = claim.triage?.status;
  if (triage && triage !== 'clean' && triage !== 'no_witness') {
    head.append(el('span', `st-badge st-triage-${triage}`, triage.replace(/_/g, ' ')));
  }
  if (claim.anchor_warning) head.append(el('span', 'st-badge st-triage-ocr_garbled', 'anchor ⚠'));
  if (claim.adjudication) {
    const adj = claim.adjudication;
    const done = el('span', 'st-badge st-done', '✓ ' + adj.label.replace(/_/g, ' '));
    done.title = `${answersText(adj)} — scored as ${SCORING[adj.label] ?? adj.label}`;
    head.append(done);
    if (adj.reference === 'details_wrong') {
      head.append(el('span', 'st-badge st-url-unchecked', `cited wrongly: ${(adj.reference_errors ?? []).join(', ')}`));
    }
    if (isRealReference(adj.reference) && !adj.supported_scope) {
      const owed = el('span', 'st-badge st-url-unchecked', 'support unanswered');
      owed.title = 'Question 2 was never answered — scored as if the work supports the claim.';
      head.append(owed);
    }
  }
  if (urlUnchecked(claim)) head.append(el('span', 'st-badge st-url-unchecked', 'URL unchecked'));
  const evidenceBadge = evidenceStateBadge(claim);
  if (evidenceBadge) head.append(evidenceBadge);
  // The one row shown DESPITE the filters (the claim under review) says so,
  // so the list never looks like the filter leaked.
  if (claim.key === state.selectedKey && !matchesFilters(claim)) {
    row.classList.add('st-claim-outside');
    head.append(el('span', 'st-badge st-outside', 'outside filter'));
  }
  row.append(head, el('span', 'st-claim-text', (claim.truth_claim ?? '').slice(0, 140)));

  row.addEventListener('click', () => selectClaim(claim));
  return row;
}

function selectClaim(claim: ClaimRow, updateUrl = true): void {
  state.selectedKey = claim.key;
  if (updateUrl) {
    history.replaceState(null, '', studyUrl(state.slug, undefined, claim.key));
  }
  renderList();
  renderDetail(claim);
  // The pane follows the selection: Hyperlit lands on this claim's node, Source swaps to THIS
  // claim's extracted text (falling back when it resolved none). Tabs refresh either way —
  // whether Source is reachable is a fact about the claim you just picked.
  refreshPaneTabs();
  renderExtractionFlag(claim);
  if (paneView === 'source') setPaneView('source');
  else if (paneView === 'hyperlit') jumpToClaimInHyperlit(claim);
}

/**
 * Re-seat the selection the URL names (refresh, or a loadBook() after a
 * citation re-run). The operator's filters are left alone — the selected
 * claim is always listed as an exception row (see visibleClaims).
 */
function restoreSelectionFromUrl(): void {
  const key = new URLSearchParams(window.location.search).get('citation');
  if (!key || !state.payload) return;
  const claim = state.payload.claims.find((c) => c.key === key);
  if (!claim) return;

  // No filter-clearing needed: the selected claim is always listed (see
  // visibleClaims), so the restore shows it as the one exception row while
  // the operator's filters stay exactly as saved.
  selectClaim(claim, false);
  document.querySelector('.st-claim-active')?.scrollIntoView({ block: 'center' });
}

/**
 * The adjudication an Ibid/short form INHERITS: an Ibid cites the same WORK as its
 * antecedent, so a source-level verdict recorded there (fabricated reference,
 * unverifiable, or simply "the work exists") settles this row's source identity —
 * only claim applicability is fresh judging. Follows llm_metadata.short_form_of
 * through the loaded payload (a ::subN row reads it off its parent claim, same as
 * LiveTraceJoiner), chaining through un-adjudicated short forms (an Ibid of an
 * Ibid) with a cycle guard. Returns the nearest adjudicated antecedent claim row.
 */
/**
 * A REAL link to another claim's workbench view, opening in a NEW TAB — never an
 * in-place jump, which throws away the operator's place mid-adjudication (the
 * selection, scroll and half-filled verdict form all die with it). The citation
 * key rides the URL, so the new tab lands selected on the named claim.
 */
function claimLinkEl(target: ClaimRow, text: string, title: string): HTMLAnchorElement {
  const a = el('a', 'st-badge st-ante-verdict', text);
  a.href = studyUrl(state.slug, undefined, target.key);
  a.target = '_blank';
  a.rel = 'noopener';
  a.title = `${title} (opens in a new tab — your place here is kept)`;
  return a;
}

/** The refId this row's short form points at — read off itself, or (for a ::subN
 *  fan-out row) off its parent claim, same as LiveTraceJoiner. */
function shortFormTargetOf(c: ClaimRow, claims: ClaimRow[]): string | null {
  const own = c.llm_metadata?.short_form_of;
  if (typeof own === 'string' && own) return own;
  const parentRef = c.referenceId?.includes('::') ? c.referenceId.split('::')[0] : null;
  const parentVal = parentRef
    ? claims.find((p) => p.referenceId === parentRef)?.llm_metadata?.short_form_of
    : null;
  return typeof parentVal === 'string' && parentVal ? parentVal : null;
}

function antecedentAdjudication(claim: ClaimRow): { ante: ClaimRow; adj: Adjudication } | null {
  const claims = state.payload?.claims ?? [];
  const shortFormOf = (c: ClaimRow): string | null => shortFormTargetOf(c, claims);

  const subSuffix = claim.referenceId?.includes('::') ? `::${claim.referenceId.split('::')[1]}` : '';
  const visited = new Set<string>();
  let ref = shortFormOf(claim);
  while (ref && !visited.has(ref)) {
    visited.add(ref);
    // Prefer the antecedent's matching sub row (same work position), then any row of it.
    const candidates = [
      ...claims.filter((c) => c.referenceId === ref + subSuffix),
      ...(subSuffix ? claims.filter((c) => c.referenceId === ref) : []),
    ];
    const adjudicated = candidates
      .filter((c) => c.adjudication)
      .sort((a, b) =>
        (b.adjudication?.adjudicated_at ?? '').localeCompare(a.adjudication?.adjudicated_at ?? ''));
    const best = adjudicated[0];
    if (best?.adjudication) return { ante: best, adj: best.adjudication };
    const first = candidates[0];
    ref = first ? shortFormOf(first) : null;
  }
  return null;
}

/**
 * The extracted work's identity key, for grouping citations of the SAME work across
 * independent footnotes. Normalised by stripping everything non-alphanumeric, which
 * deliberately collapses OCR spacing damage — deloitte c23 prints "Administrative
 * Ju stice" where the antecedent of c21/c22 prints "Justice", and they are one work.
 * Short titles need a year to vouch (two "Centrelink"s alone are not identity).
 */
function workIdentity(c: ClaimRow): { title: string; year: string | null } | null {
  const title = c.llm_metadata?.title;
  if (typeof title !== 'string' || !title) return null;
  const norm = title.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!norm) return null;
  const year = c.llm_metadata?.year != null ? String(c.llm_metadata.year) : null;
  return { title: norm, year };
}

/** Same work? Titles must agree exactly (normalised); a year present on BOTH sides must
 *  agree; a short title (<12 chars) is only identity when a shared year vouches for it. */
function sameWork(a: { title: string; year: string | null }, b: { title: string; year: string | null }): boolean {
  if (a.title !== b.title) return false;
  if (a.year && b.year) return a.year === b.year;
  return a.title.length >= 12;
}

/**
 * A verdict this claim's SOURCE inherits from elsewhere in the book: via the Ibid
 * chain (antecedentAdjudication), or — failing that — from any adjudicated claim
 * citing the SAME WORK in full (same normalised title+year). A work-level verdict
 * ("that work does not exist") is true for every citation of the work however it is
 * cited; claim applicability never inherits and stays the reviewer's own judgement.
 */
function inheritedSourceVerdict(
  claim: ClaimRow,
): { ante: ClaimRow; adj: Adjudication; via: 'antecedent' | 'same work' } | null {
  const viaChain = antecedentAdjudication(claim);
  if (viaChain) return { ...viaChain, via: 'antecedent' };

  const mine = workIdentity(claim);
  if (!mine) return null;
  const twins = (state.payload?.claims ?? [])
    .filter((c) => {
      if (c.key === claim.key || !c.adjudication) return false;
      const theirs = workIdentity(c);
      return theirs !== null && sameWork(mine, theirs);
    })
    .sort((a, b) =>
      (b.adjudication?.adjudicated_at ?? '').localeCompare(a.adjudication?.adjudicated_at ?? ''));
  const best = twins[0];
  return best?.adjudication ? { ante: best, adj: best.adjudication, via: 'same work' } : null;
}

/**
 * Whether this claim's verdict is BACKED by a quotation. Three states, and the
 * ABSENT one is the point:
 *  - `quoted` — the adjudication carries evidence, or an applied one left it in
 *    ground truth (a frozen corpus keeps only the latter);
 *  - `owed` — a label that could be quoted but wasn't: an assertion, by the
 *    same rule the detail-pane nag uses;
 *  - `null` — nothing to quote (unadjudicated, or a non-scored label).
 *
 * ONE definition, because the badge and the "needs evidence" filter are the
 * same question asked twice — a row that shows the amber badge and then hides
 * from the filter meant to collect it would be worse than neither.
 */
function evidenceState(claim: ClaimRow): 'quoted' | 'inherited' | 'owed' | null {
  const adj = claim.adjudication;
  if (adj?.evidence || claim.gt?.evidence) return 'quoted';
  if (adj && labelExpectsEvidence(adj.label)) {
    return inheritedEvidence(claim) ? 'inherited' : 'owed';
  }
  return null;
}

/**
 * The evidence an inherited verdict RESOLVES to. A fabrication proof is about the
 * WORK, so the quotes recorded on the antecedent's verdict hold for every citation
 * of that work — an Ibid labelled fabricated one hop from its proof is EVIDENCED,
 * not an assertion, and the system can derive that itself (it already knows the
 * inheritance). Derived at read time so nothing has to be re-saved or copied:
 * requires the claim's own verdict to lack quotes, the labels to AGREE (a different
 * label is a different judgement — its proof does not transfer), and SOME member of
 * the work's whole inheritance family — however many hops away — to carry evidence.
 */
function inheritedEvidence(
  claim: ClaimRow,
): { ante: ClaimRow; anteId: string; quote: string; locator: string | null } | null {
  const adj = claim.adjudication;
  if (!adj || adj.evidence || claim.gt?.evidence) return null;
  const claims = state.payload?.claims ?? [];

  // The proof can sit ANY number of hops away — deloitte c24 inherits from c23
  // (Ibid), c23 from c22 (same work), c22 from c131, where the quotes actually
  // live — so this walks the whole FAMILY: the transitive closure over both
  // inheritance edges (short-form chains, followed in either direction, and
  // same-work identity). The donor is the latest same-label family member
  // carrying evidence; an unevidenced middle link never blocks resolution.
  const seen = new Set<string>([claim.key]);
  const family: ClaimRow[] = [];
  let frontier: ClaimRow[] = [claim];
  while (frontier.length > 0 && seen.size < 80) {
    const next: ClaimRow[] = [];
    for (const c of frontier) {
      const ref = shortFormTargetOf(c, claims);
      const mine = workIdentity(c);
      for (const t of claims) {
        if (seen.has(t.key)) continue;
        const tRef = shortFormTargetOf(t, claims);
        const chainForward = !!ref
          && (t.referenceId === ref || !!t.referenceId?.startsWith(`${ref}::`));
        const chainBack = !!tRef
          && (c.referenceId === tRef || !!c.referenceId?.startsWith(`${tRef}::`));
        const theirs = mine ? workIdentity(t) : null;
        if (!chainForward && !chainBack && !(mine && theirs && sameWork(mine, theirs))) continue;
        seen.add(t.key);
        family.push(t);
        next.push(t);
      }
    }
    frontier = next;
  }

  const donor = family
    .filter((c) => c.adjudication?.label === adj.label
      && (c.adjudication?.evidence || c.gt?.evidence))
    .sort((a, b) =>
      (b.adjudication?.adjudicated_at ?? '').localeCompare(a.adjudication?.adjudicated_at ?? ''))[0];
  if (!donor) return null;
  return {
    ante: donor,
    anteId: donor.gt?.gt_id ?? donor.referenceId ?? 'antecedent',
    quote: donor.adjudication?.evidence ?? donor.gt?.evidence ?? '',
    locator: donor.adjudication?.evidence_locator ?? donor.gt?.evidence_locator ?? null,
  };
}

/** The evidence state as a list badge — the detail pane's evidence block, hoisted. */
function evidenceStateBadge(claim: ClaimRow): HTMLElement | null {
  const st = evidenceState(claim);
  if (st === 'quoted') {
    const badge = el('span', 'st-badge st-evidenced', '❝ evidenced');
    if (!claim.adjudication?.evidence) badge.title = 'Evidence already applied into ground truth';
    return badge;
  }
  if (st === 'inherited') {
    const badge = el('span', 'st-badge st-evidenced', '❝ evidenced (inherited)');
    badge.title = 'The proof lives on the antecedent’s verdict — same work, same evidence.';
    return badge;
  }
  if (st === 'owed') {
    const badge = el('span', 'st-badge st-unevidenced', 'no evidence');
    badge.title = 'This label is an assertion until it carries a quotation';
    return badge;
  }
  return null;
}

/** In Hyperlit view, land the source pane on the claim's own node. */
function jumpToClaimInHyperlit(claim: ClaimRow): void {
  const url = hyperlitAnchorUrl(claim);
  if (!url) return;
  const frame = byId<HTMLIFrameElement>('st-pdf-frame');
  frame.setAttribute('data-view-url', url);
  navigateFrame(frame, url);
}

// ---------------------------------------------------------------- detail pane

function renderDetail(claim: ClaimRow): void {
  const pane = byId<HTMLElement>('st-detail');
  const frag = document.createDocumentFragment();

  const marker = claim.gt?.footnote_marker ? `Footnote ${claim.gt.footnote_marker}` : (claim.key);
  frag.append(el('h2', 'st-detail-title', marker));
  frag.append(bookContextLine());

  // The citation's OWN anchor looks wrong → the pairing under review may not
  // be one the author made. Shown FIRST: judging the citation is pointless
  // until you know the claim/source pairing is real.
  if (claim.anchor_warning) {
    frag.append(el('p', 'st-anchor-warning', `⚠ ${claim.anchor_warning}`));
  }

  // The citation as printed.
  if (claim.bib_citation) {
    frag.append(section('Citation as printed', htmlToText(claim.bib_citation)));
  }

  // "Resolved source" belongs directly under the citation it resolves: that is where a
  // reviewer looks for it, and reading a verdict before knowing WHICH work was checked is
  // backwards. It is the longest block and is built further down, so remember the node it
  // has to land in front of. Stays null when nothing follows — insertBefore(null) appends.
  let sourceSlot: Node | null = null;

  // Claims.
  if (claim.truth_claim) {
    const sec = section('Truth claim', claim.truth_claim);
    const provenance = CLAIM_SOURCE_NOTES[claim.claim_source ?? ''];
    // Where the claim text came from, when it did NOT come from the model. A scoped or rescued
    // claim reads identically to one the model wrote, and the difference is exactly what a weak
    // verdict has to be read against.
    if (provenance) sec.append(el('p', 'st-muted', provenance));
    frag.append(sec);
    sourceSlot ??= sec;
  }
  if (claim.contextualised_claim && claim.contextualised_claim !== claim.truth_claim) {
    const ctxSec = section('Contextualised', claim.contextualised_claim);
    frag.append(ctxSec);
    sourceSlot ??= ctxSec;
  }

  // AI verdict.
  const verdictSec = el('section', 'st-section');
  verdictSec.append(el('h3', undefined, 'AI verdict'));
  verdictSec.append(el('p', `st-badge st-verdict-${claim.verdict}`, claim.verdict.replace(/_/g, ' ')));
  if (claim.llm_verdict?.summary) verdictSec.append(el('p', 'st-muted', claim.llm_verdict.summary));
  if (claim.llm_verdict?.reasoning) {
    const details = el('details');
    details.append(el('summary', undefined, 'Reasoning'), el('p', undefined, claim.llm_verdict.reasoning));
    verdictSec.append(details);
  }
  frag.append(verdictSec);
  sourceSlot ??= verdictSec;

  // Resolved source (or not).
  const srcSec = el('section', 'st-section');
  srcSec.append(el('h3', undefined, 'Resolved source'));
  // A bare "Ibid." is unactionable on its own. The scan inherits the antecedent's work onto
  // the claim, but the reviewer saw only "Ibid." over "No source found by the resolver" —
  // with the inheritance visible nowhere except the hostname under Check link, which reads
  // as the resolver having done nothing. Say which work it is, above the verdict on it.
  if (claim.short_form_of) {
    srcSec.append(el('p', 'st-shortform', claim.short_form_of));
  }
  // A verdict this source inherits from elsewhere in the book: the Ibid antecedent, or
  // another full citation of the SAME work (normalised title+year, so OCR spacing damage
  // like "Ju stice" still groups). Shown wherever the source is judged, one click to the row.
  {
    const inh = inheritedSourceVerdict(claim);
    if (inh && !claim.adjudication) {
      const b = claimLinkEl(inh.ante, `${inh.via} verdict: ${answersText(inh.adj)} ↗`,
        inh.via === 'antecedent'
          ? 'The source this Ibid inherits was already adjudicated'
          : 'Another citation of this same work was already adjudicated');
      const wrap = el('p');
      wrap.append(b);
      srcSec.append(wrap);
    }
  }
  if (claim.source.found) {
    const bits = [
      claim.source.title,
      claim.source.author,
      claim.source.year != null ? String(claim.source.year) : null,
    ].filter(Boolean);
    srcSec.append(el('p', undefined, bits.join(' — ') || claim.source.book_id || ''));
    srcSec.append(
      el(
        'p',
        'st-muted',
        `match: ${claim.source.match_method ?? '?'}${claim.source.match_score != null ? ` (${claim.source.match_score})` : ''} · evidence: ${claim.source.evidence_type ?? 'none'} · tier: ${claim.source.verification_tier ?? '?'}`,
      ),
    );
    // Identity certain, YEAR divergent — the match was accepted, but the divergence is a fact
    // about the citation the reviewer must see: a different edition/printing of the same work, or
    // the author's printed details are wrong. Pairs naturally with the "citation typo" cause.
    if (claim.source.edition_mismatch) {
      const em = claim.source.edition_mismatch;
      srcSec.append(el(
        'p',
        'st-conv-warn',
        `⚠ Year mismatch on an otherwise-exact match: printed ${em.printed_year ?? '?'}, record ${em.record_year}. `
        + 'Same work, divergent details — likely another edition/printing, or the citation year is wrong. Judge which.',
      ));
    }
    // Chapter in an edited volume: the year diverged, but the record's container agrees with
    // the volume printed in the citation — that containment is what vouched for the match.
    if (claim.source.container_corroborated) {
      const cc = claim.source.container_corroborated;
      srcSec.append(el(
        'p',
        'st-conv-warn',
        `⚠ Year mismatch (printed ${cc.printed_year ?? '?'}, record ${cc.record_year ?? '?'}) on a chapter match `
        + `vouched for by its volume: citation prints “${cc.printed_container ?? '?'}”, record belongs to `
        + `“${cc.record_container ?? '?'}”. Likely another edition of the volume, or the citation year is wrong.`,
      ));
    }
    // Loud, because every other signal still reads "canonical match, high confidence" — the
    // reviewer would otherwise judge the claim against a work it was never about. The CAUSE is
    // spelled out: telling someone to check a DOI that is perfectly correct (the multi-work
    // case) sends them to inspect something that is fine.
    if (claim.source.work_mismatch) {
      const wm = claim.source.work_mismatch;
      const warn = el('div', 'st-conv-bad');
      warn.append(el('p', undefined, '⚠ The source below is NOT the work this claim is about — the verdict is void, not negative.'));
      warn.append(el('p', 'st-muted', `claim is about: \u201C${wm.cited_title ?? '?'}\u201D`
        + (wm.cited_year ? ` (${wm.cited_year})` : '')));
      warn.append(el('p', 'st-muted', `verified against: \u201C${wm.matched_title ?? '?'}\u201D`
        + (wm.matched_year ? ` (${wm.matched_year})` : '')));
      warn.append(el('p', 'st-muted',
        wm.cause === 'multi_work'
          ? `Cause: this entry cites ${wm.total_works ?? '?'} works and we matched #${wm.matched_work_position ?? '?'}. `
            + 'The identifier is correct for the work it named — the DOI is not the problem.'
          : wm.cause === 'identifier'
            ? 'Cause: the identifier names the other work — mistyped in the source, or mis-extracted by us.'
            : 'Cause: a title-similarity match reached the wrong work.'));
      srcSec.append(warn);
    }
    if (claim.source.url || claim.source.doi) {
      const p = el('p');
      const a = el('a', undefined, claim.source.url ?? `doi:${claim.source.doi}`);
      a.setAttribute('href', claim.source.url ?? `https://doi.org/${claim.source.doi}`);
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener');
      p.append(a);
      srcSec.append(p);
    }
    const urlCheck = sourceMatchWidget(claim);
    if (urlCheck) srcSec.append(urlCheck);
    // What we actually READ, as distinct from what we found. An
    // `article_extract` is not the work — page furniture was stripped and some
    // article text may have gone with it, so a claim missing from it is
    // inconclusive rather than refuted.
    if (claim.source.content_grade_note) {
      srcSec.append(el('p', 'st-muted', `content: ${claim.source.content_grade_note}`));
    }
    // WHAT WE ACTUALLY KEPT. The verifier is shown three or four passages, so until this was
    // here a nav rail we scraped and a whole article read identically from the console — and a
    // verdict about our extraction was indistinguishable from a verdict about the citation.
    srcSec.append(extractedSourceLine(claim));
    if (claim.source.web_status === 'rejected') {
      srcSec.append(
        el(
          'p',
          'st-warn',
          'The page at this URL does NOT match the cited title — it hosts a different article. Treat its text as untrusted evidence about this citation.',
        ),
      );
    }
  } else {
    srcSec.append(el('p', 'st-muted', 'No source found by the resolver.'));
    // WHY it found nothing. This is the difference between a fabricated
    // reference and a live source we were bot-blocked from, which decides
    // whether the verdict is a correct_flag or a resolver_gap.
    const f = claim.source.fetch_outcome;
    if (f) {
      const status = f.http_status ? ` (HTTP ${f.http_status})` : '';
      const via = f.channel && f.channel !== 'none' ? ` · tried via ${f.channel}` : '';
      srcSec.append(el('p', `st-badge st-fetch-${f.outcome}`, f.outcome.replace(/_/g, ' ')));
      srcSec.append(el('p', 'st-muted', `${f.reason ?? ''}${status}${via}`));
      // A refusal that read the page's OWN title has still confirmed something: when
      // it matches the citation, the reference EXISTS — only its content went unread
      // (paywall interstitial, foreign-language video).
      if (f.title) {
        srcSec.append(el(
          'p',
          'st-muted',
          `The refused page declares its title as “${f.title}” — if that matches the citation, the reference exists; only its content is unread.`,
        ));
      }
    }
  }
  // The URL as PRINTED in the citation (llm_metadata) — checkable even (and
  // especially) when the resolver found nothing: dead-link is a
  // source_not_found subcategory the reviewer shouldn't diagnose by hand.
  const citedUrl =
    (typeof (claim.llm_metadata as { url?: unknown } | null)?.url === 'string'
      ? ((claim.llm_metadata as { url: string }).url)
      : null) ?? claim.source.url;
  if (citedUrl && /^https?:\/\//i.test(citedUrl)) {
    srcSec.append(checkLinkButton(citedUrl, claim));
  }
  frag.insertBefore(srcSec, sourceSlot);

  // The PATH this citation took through resolution — every wave it entered, in order, with
  // what each one concluded. This is the ledger that used to require a database console:
  // "ran and found nothing" vs "never reached" vs "skipped because no API key", each step
  // linking to the wave's own source file.
  frag.insertBefore(pathSection(claim), sourceSlot);

  // Re-run just this citation (extraction → ladder → review) after a pipeline
  // fix — patches the fresh rows into a sub-versioned run ({base}.N) without
  // re-billing the whole book.
  frag.insertBefore(rerunSection(claim), sourceSlot);

  // Conversion check — was it OUR OCR?
  const convSec = el('section', 'st-section');
  convSec.append(el('h3', undefined, 'Conversion check'));
  if (claim.triage) {
    convSec.append(el('p', `st-badge st-triage-${claim.triage.status}`, claim.triage.status.replace(/_/g, ' ')));
    if (claim.triage.invented_tokens) {
      convSec.append(el('p', 'st-conv-bad', `Invented by the converter: ${claim.triage.invented_tokens}`));
    }
    if (claim.triage.diffs) {
      claim.triage.diffs.split(' ; ').forEach((d) => convSec.append(el('p', 'st-conv-diff', d)));
    }
    if (!claim.triage.invented_tokens && !claim.triage.diffs) {
      convSec.append(el('p', 'st-muted', 'No OCR damage detected for this citation.'));
    }
  } else {
    convSec.append(el('p', 'st-muted', 'No triage data — run citation:study:triage --write.'));
  }
  convSec.append(flagConversionButton(claim));
  frag.append(convSec);

  // The individual passages the search stage picked. Rendered separately from
  // the concatenated blob below because each one is a self-contained quotation
  // the reviewer can lift straight into their evidence — and because until now
  // `passages` was carried in the payload and never shown at all.
  const passages = (claim.source.passages ?? []).filter((p) => (p?.text ?? '').trim() !== '');
  if (passages.length > 0) {
    const sec = el('section', 'st-section');
    sec.append(el('h3', undefined, 'Passages the verifier was shown'));
    passages.forEach((passage, i) => {
      const row = el('div', 'st-passage');
      row.append(el('blockquote', 'st-evidence-quote', (passage.text ?? '').trim()));
      const use = el('button', 'st-useevidence', '⤓ use as evidence');
      use.type = 'button';
      use.title = 'Append this passage to the evidence box below';
      use.addEventListener('click', () => {
        // getElementById, not byId: on an already-adjudicated claim the editor
        // is collapsed until "Add evidence" is pressed, so its absence is a
        // normal state that deserves an instruction, not a thrown error.
        const box = document.getElementById('st-evidence') as HTMLTextAreaElement | null;
        if (!box) {
          flash(row, 'Press "Add evidence" on the verdict below first, then use this button.');
          return;
        }
        appendEvidence(box, (passage.text ?? '').trim());
        box.scrollIntoView({ block: 'nearest' });
      });
      row.append(use);
      if (passage.node_id) row.append(el('span', 'st-muted', ` ${passage.node_id}`));
      sec.append(row);
      if (i < passages.length - 1) sec.append(el('hr', 'st-passage-rule'));
    });
    frag.append(sec);
  }

  // What the verifier saw.
  if (claim.source_material_sent) {
    const details = el('details', 'st-section');
    details.append(el('summary', undefined, 'Source material sent to the LLM'));
    details.append(el('pre', 'st-material', claim.source_material_sent));
    frag.append(details);
  }

  frag.append(adjudicationForm(claim));
  pane.replaceChildren(frag);

  prefillPdfSearch(claim);
}

/** A thin extraction is the commonest reason a real source "doesn't support" a claim. */
const THIN_EXTRACTION_CHARS = 1200;

/**
 * "What we extracted" — the size of the stored source, and the way into reading all of it.
 *
 * Every resolved source is stored as a real book (a `web_…` stub, or an existing library work),
 * but the console only ever showed the three or four passages the search stage picked, so there
 * was no way to tell a bad verdict from a bad scrape. The character count is the tell: a
 * 400-character "article" is page furniture, and a claim missing from it says nothing about the
 * citation.
 */
/**
 * The citation's resolution path, as a lit rail: one row per station it passed through, dot
 * coloured by what happened there, wave-recorded evidence expandable under the step it belongs
 * to, and each station linking to its own source file on GitHub. Vocabulary and labels come from
 * ResolutionLadderMap via CitationPath, the same builder the reader-facing report renders — the
 * two surfaces cannot disagree about what happened.
 */
function pathSection(claim: ClaimRow): HTMLElement {
  const sec = el('section', 'st-section st-path');
  sec.append(el('h3', undefined, 'Resolution path'));

  const path = claim.path;
  if (!path || path.steps.length === 0) {
    sec.append(el('p', 'st-muted', 'No path data for this citation.'));
    return sec;
  }

  // Rows scanned before tracing landed carry a synthesized single step. Say so — the absence
  // is about WHEN the row was scanned, and must never read as "the ladder did not run".
  if (!path.recorded) {
    sec.append(el('p', 'st-muted',
      'Path not recorded — this row predates per-wave tracing. Shown below is only what its '
      + 'stored columns testify to; re-scan the book to record the full path.'));
  }

  const works = path.works ?? {};

  // A multi-work footnote runs one ladder per work, and the rails are indistinguishable without
  // their subject — same stations, same dots. Name the work ABOVE its rail; the reviewer should
  // never have to infer it from a Brave query inside a collapsed step.
  if (works.steps) sec.append(workHeading(works.steps));
  sec.append(pathRail(path.steps));

  // Sub-citations traverse the ladder as their own entries; their rails nest under the parent.
  for (const [subKey, steps] of Object.entries(path.subs ?? {})) {
    const work = works[subKey];
    const det = el('details', 'st-path-sub');
    det.append(el('summary', undefined, work
      ? `Work ${work.position} of ${work.total} — ${work.label}`
      : `${subKey} — this footnote cites several works; the path for this one`));
    if (work) det.append(workHeading(work, { nested: true }));
    det.append(pathRail(steps));
    sec.append(det);
  }

  // A cited work with NO rail is invisible otherwise — and a work that was never searched is a
  // fact about our pipeline masquerading as a citation that could not be found.
  for (const [key, work] of Object.entries(works)) {
    if (key === 'steps' || path.subs?.[key]) continue;
    const det = el('details', 'st-path-sub st-path-sub-norail');
    det.append(el('summary', undefined, `Work ${work.position} of ${work.total} — ${work.label}`));
    det.append(el('p', 'st-muted', work.searched === false
      ? (work.skipped ?? 'This work never entered the resolver.')
      : 'No path recorded for this work — it may predate per-step tracing, or its search may have '
        + 'been retired when another work in the same footnote resolved. Re-scan the book to find out.'));
    sec.append(det);
  }

  return sec;
}

/**
 * The work a rail is about: position within the footnote, then who/when/what. Rendered only for
 * MULTI-work entries (the builder returns no works for a single-work citation, where the rail
 * can only be about the one work and a heading would be noise).
 */
function workHeading(work: PathWork, opts: { nested?: boolean } = {}): HTMLElement {
  const box = el('div', 'st-path-work');

  if (!opts.nested) {
    box.append(el('span', 'st-path-work-pos', `Work ${work.position} of ${work.total}`));
  }
  box.append(el('span', 'st-path-work-label', work.label));
  if (work.type) box.append(el('span', 'st-path-work-type', work.type.replace(/-/g, ' ')));
  if (work.status === 'matched') box.append(el('span', 'st-path-work-status', 'resolved'));

  return box;
}

function pathRail(steps: PathStep[]): HTMLElement {
  const rail = el('ol', 'st-path-rail');

  for (const step of steps) {
    const row = el('li', `st-path-step st-path-${outcomeClass(step.outcome)}`);

    const head = el('div', 'st-path-head');
    head.append(el('span', 'st-path-dot'));
    head.append(el('span', 'st-path-title', step.title));
    head.append(el('span', 'st-path-outcome', step.outcome.replace(/_/g, ' ')
      + (step.score != null ? ` · ${step.score}` : '')));
    if (step.source_url) {
      const a = el('a', 'st-path-code', 'code ↗');
      a.setAttribute('href', step.source_url);
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener');
      a.title = step.code_ref ?? '';
      head.append(a);
    }
    row.append(head);

    if (step.reason) {
      row.append(el('p', 'st-muted st-path-reason', `skipped: ${step.reason}`));
    }

    // What the wave itself recorded here — the fetch grade, the Brave query and its host
    // refusals, the best sub-threshold score. This is the evidence that used to be reachable
    // only through tinker.
    if (step.detail && Object.keys(step.detail).length > 0) {
      const det = el('details', 'st-path-detail');
      det.append(el('summary', undefined, 'what this step recorded'));
      const pre = el('pre', undefined, JSON.stringify(step.detail, null, 2));
      det.append(pre);
      row.append(det);
    }

    rail.append(row);
  }

  return rail;
}

/** Collapse outcome variants onto the palette's semantic classes. */
function outcomeClass(outcome: string): string {
  if (outcome === 'newly_resolved' || outcome === 'enriched') return 'resolved';
  if (outcome === 'skipped') return 'skipped';
  if (outcome === 'routed') return 'routed';
  if (outcome === 'retired_with_relative') return 'retired';
  if (outcome === 'not_a_citation' || outcome === 'excluded_by_design') return 'excluded';
  if (outcome === 'inherited_antecedent' || outcome === 'matched_own_bibliography') return 'resolved';
  return 'nomatch';
}

function extractedSourceLine(claim: ClaimRow): HTMLElement {
  const wrap = el('p', 'st-extracted');
  const stored = claim.source.stored;
  if (!claim.source.book_id) {
    wrap.append(el('span', 'st-muted', 'No stored source text.'));
    return wrap;
  }
  const btn = el('button', 'st-undo', 'Read what we extracted');
  btn.type = 'button';
  btn.addEventListener('click', () => setPaneView('source'));
  wrap.append(btn);

  // The BOOK itself, in the real reader, in its own tab. The pane is for reading it beside the
  // claim; this is for everything else — sharing the id, poking at it properly, seeing it the
  // way a user would. Web stubs are `visibility: public` (just unlisted) so this opens; a
  // private non-web source will 404, which is itself worth knowing.
  const open = el('a', 'st-open-link', `open ${claim.source.book_id} ↗`);
  open.setAttribute('href', `/${encodeURIComponent(claim.source.book_id)}`);
  open.setAttribute('target', '_blank');
  open.setAttribute('rel', 'noopener');
  open.title = 'Open this source book in the reader, in a new tab';
  wrap.append(open);

  if (!stored || stored.chars === 0) {
    wrap.append(el('span', 'st-conv-bad',
      ' nothing stored — the source was identified but no readable body was kept, '
      + 'so any "not supported" verdict came from the abstract alone.'));
  } else {
    const size = `${stored.chars.toLocaleString()} chars · ${stored.nodes} nodes`;
    wrap.append(el('span', stored.chars < THIN_EXTRACTION_CHARS ? 'st-conv-warn' : 'st-muted',
      stored.chars < THIN_EXTRACTION_CHARS
        ? ` ${size} — THIN. Check this is the article and not page furniture before trusting a rejection.`
        : ` ${size}`));
  }
  return wrap;
}

/**
 * Live-probe the cited URL: HTTP status + soft-404 sniff, rendered inline.
 * A DEAD result closes its own loop — one click saves the adjudication
 * (unverifiable + dead_link, note carrying the probe evidence) instead of
 * sending the reviewer back to the chips.
 */
function checkLinkButton(url: string, claim: ClaimRow): HTMLElement {
  const wrap = el('div', 'st-checklink');
  const btn = el('button', 'st-undo', 'Check link');
  btn.type = 'button';
  btn.title = url;
  // The cited URL itself, always clickable — "open it and judge" is useless
  // if the reviewer has to fish the URL out of a tooltip.
  const open = el('a', 'st-open-link');
  open.textContent = `open ↗ ${new URL(url).hostname}`;
  open.setAttribute('href', url);
  open.setAttribute('target', '_blank');
  open.setAttribute('rel', 'noopener');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Checking…';
    const { status, data } = await api.checkLink(url);
    btn.disabled = false;
    btn.textContent = 'Check link';
    const line = el('p');
    let deadSummary: string | null = null;
    // A repaired URL changes what the result MEANS: the source may be perfectly alive while the
    // link we stored was broken — which is a conversion defect worth recording separately.
    const repairedNote = data.repaired && data.checked_url
      ? ` (our stored link was malformed — checked the repaired URL ${data.checked_url})`
      : '';
    if (status !== 200 || !data.ok) {
      // OUR failure, and it must not read as a finding about the citation. A bare "Check failed
      // (422)" is our own validator refusing a malformed stored URL — the reviewer saw that and
      // reasonably read it as the link being broken.
      line.className = 'st-conv-warn';
      line.textContent =
        `⚠ OUR check could not run (${data.error ?? status}) — this says nothing about the citation. `
        + 'Open the link yourself to judge.';
    } else if (data.unparsable) {
      // The stored link text is not a URL at all — a conversion defect, not link rot.
      line.className = 'st-conv-warn';
      line.textContent =
        `⚠ ${data.error ?? 'We could not parse a URL out of this reference.'} `
        + 'Our stored link is mangled — judge the citation from the reference text, and consider the '
        + '"conversion mangled" cause.';
    } else if (!data.reachable) {
      // Connection-level failure: could be a dead domain OR aggressive bot
      // blocking — too ambiguous for a one-click verdict. Human checks.
      line.className = 'st-conv-warn';
      line.textContent = `⚠ Unreachable from the server (${data.error ?? 'connection failed'}) — could be dead OR blocking bots. Open it in your browser to judge.`;
    } else if (data.category === 'blocked') {
      // Access denied ≠ gone. A paywalled Reuters article 401s our fetcher
      // and renders fine in a browser — never call this dead.
      line.className = 'st-conv-warn';
      // Name the challenge when the server gave one: a WAF challenge served as 2xx is the case
      // that used to render as a green ✓, telling the reviewer the source was fine when our
      // system had not read a word of it.
      line.textContent = data.challenge
        ? `⚠ HTTP ${data.status} but this is a BOT CHALLENGE (${data.challenge}) — the link is REAL and alive, but our system was never given the page. Open it in your browser to judge; cause chip: "access blocked".`
        : `⚠ HTTP ${data.status} — access blocked (paywall / bot wall). The link likely WORKS in a browser — open it and judge; cause chip: "access blocked".`;
    } else if (data.category === 'server_error') {
      line.className = 'st-conv-warn';
      line.textContent = `⚠ HTTP ${data.status} — server error. Inconclusive; retry later.`;
    } else if (data.dead) {
      line.className = 'st-conv-bad';
      deadSummary = data.soft404
        ? `soft-404: HTTP ${data.status}, page says "${data.matched_phrase}"`
        : `HTTP ${data.status}`;
      line.textContent = data.soft404
        ? `✗ Soft-404 — HTTP ${data.status} but the page says "${data.matched_phrase}"${data.title ? ` (title: ${data.title})` : ''}. Dead link.`
        : `✗ HTTP ${data.status} — dead link (gone).`;
    } else {
      line.className = 'st-muted';
      line.textContent = `✓ HTTP ${data.status}${data.title ? ` — "${data.title}"` : ''}${data.paywalled ? ' — paywalled preview' : ''}${data.final_url && data.final_url !== url ? ` (redirected)` : ''}`;
    }
    // Append the repair note to whatever verdict we reached: a "dead link" on a URL WE mangled is
    // a different finding from a dead link the author printed, and the reviewer must be able to
    // tell them apart before recording a cause.
    if (repairedNote && line.textContent) {
      line.textContent += repairedNote;
    }
    wrap.querySelectorAll('p, .st-save').forEach((n) => n.remove());
    wrap.append(line);

    if (deadSummary) {
      wrap.append(quickSaveButton(claim, wrap, {
        text: "Save verdict: can't confirm it exists · dead link",
        reference: 'unverifiable',
        cause: 'dead_link',
        note: `Check link: ${deadSummary} — ${url}`,
      }));
    } else if (data.ok && data.reachable && data.category === 'blocked') {
      // The three outcomes of the browser check, each one click. A paywall splits the two
      // questions: the work's EXISTENCE (title/author visible behind most paywalls) is
      // question 1; claim SUPPORT (needs the body) is question 2.
      wrap.append(
        quickSaveButton(claim, wrap, {
          text: 'Read the body, it supports the claim → real · supports the whole claim',
          reference: 'verified',
          scope: 'whole_claim',
          cause: 'access_blocked',
          note: `Check link: HTTP ${data.status} blocked our fetcher; read in browser, claim supported — ${url}`,
        }),
        quickSaveButton(claim, wrap, {
          text: "Title/author match through the paywall, body unreadable → real · can't tell",
          reference: 'verified',
          scope: 'undetermined',
          cause: 'access_blocked',
          note: `Check link: HTTP ${data.status} blocked our fetcher; work confirmed real through paywall, claim support unverifiable — ${url}`,
        }),
        quickSaveButton(claim, wrap, {
          text: "Couldn't even confirm the work → can't confirm it exists",
          reference: 'unverifiable',
          cause: 'access_blocked',
          note: `Check link: HTTP ${data.status} blocked our fetcher; could not confirm the work exists — ${url}`,
        }),
      );
    }
  });
  wrap.append(btn, open);
  return wrap;
}

/** One-click adjudication button used by the link-check verdict shortcuts. */
function quickSaveButton(
  claim: ClaimRow,
  wrap: HTMLElement,
  opts: { text: string; reference: string; scope?: string; cause: string; note: string },
): HTMLButtonElement {
  const save = el('button', 'st-save', opts.text);
  save.type = 'button';
  save.title = 'One-click adjudication — Change verdict on the saved verdict if you change your mind.';
  save.addEventListener('click', async () => {
    if (!state.slug) return;
    save.disabled = true;
    const { status: st, data: res } = await api.adjudicate(state.corpus, state.slug, {
      key: claim.key,
      reference: opts.reference,
      supported_scope: opts.scope ?? null,
      cause: opts.cause,
      note: opts.note.slice(0, 1900),
      found_url: null,
      referenceId: claim.referenceId,
      run_id: state.payload?.run_id ?? null,
    });
    save.disabled = false;
    if (st !== 200 || !res.ok || !res.adjudication) {
      flash(wrap, res.error ?? `Save failed (${st})`);
      return;
    }
    if (!claim.adjudication) bumpAdjudicatedCount(1);
    claim.adjudication = res.adjudication;
    renderList();
    renderApplyBar();
    renderDetail(claim); // re-render: shows the saved verdict
  });
  return save;
}

/**
 * File the SOURCE book into the bad-conversion queue (/maintainer/conversion)
 * with a reason pre-filled from this claim — the workbench keeps surfacing
 * conversion-caused defects (OCR-garbled footnotes, phantom year-range
 * citation links) that deserve a reconvert-queue item, not just a note.
 */
/**
 * "Re-run this citation": POSTs the rerun endpoint (which queues
 * StudyCitationRerunJob), then polls the per-book status file until the
 * patched run lands and reloads the payload — the card then shows the fresh
 * extraction/ladder/verdict. A 409 means a re-run is already draining for
 * this book; attach to it by polling instead of failing.
 */
function rerunSection(claim: ClaimRow): HTMLElement {
  const sec = el('section', 'st-section');
  const wrap = el('div', 'st-flagconv');
  const btn = el('button', 'st-undo', 'Re-run this citation');
  btn.type = 'button';
  const note = el('p', 'st-muted');

  const poll = async (): Promise<void> => {
    const corpus = state.corpus;
    const slug = state.slug;
    if (!slug) return;
    for (let i = 0; i < 360; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      if (state.corpus !== corpus || state.slug !== slug) return; // navigated away
      let status;
      try {
        status = await api.rerunStatus(corpus, slug);
      } catch {
        continue; // transient — keep polling
      }
      if (status.status === 'completed') {
        note.textContent = `✓ Patched run ${status.run_id ?? ''} — reloading…`;
        await loadBook();
        return;
      }
      if (status.status === 'failed') {
        btn.disabled = false;
        note.textContent = `Re-run failed: ${status.error ?? 'unknown error'}`;
        return;
      }
      note.textContent = `Re-running (${status.status ?? 'waiting'})… the queue worker must be running.`;
    }
    btn.disabled = false;
    note.textContent = 'Re-run still not finished after 30 min — check the queue worker and state.json.';
  };

  btn.addEventListener('click', async () => {
    if (!state.slug) return;
    const ok = await confirmDialog({
      title: 'Re-run this citation',
      message:
        `Re-extract, re-resolve and re-review ${claim.key} and patch it into a new sub-versioned run?\n\n`
        + 'Bills this citation’s LLM/fetch spend only. Refused if the corpus is frozen or the book '
        + 'was re-imported since the base run (then re-run the whole book instead).',
      confirmLabel: 'Re-run it',
    });
    if (!ok) return;
    btn.disabled = true;
    note.textContent = 'Queueing…';
    const { status, data } = await api.rerun(state.corpus, state.slug, claim.key);
    if (status === 202 || status === 409) {
      note.textContent = status === 409
        ? 'A re-run is already in progress for this book — attaching to it…'
        : 'Queued — waiting for the worker…';
      void poll();
      return;
    }
    btn.disabled = false;
    note.textContent = data.error ?? `Re-run request failed (${status})`;
  });

  wrap.append(btn);
  sec.append(wrap, note);
  return sec;
}

function flagConversionButton(claim: ClaimRow): HTMLElement {
  const wrap = el('div', 'st-flagconv');
  const btn = el('button', 'st-undo', 'Flag conversion issue');
  btn.type = 'button';
  btn.addEventListener('click', async () => {
    if (!state.slug) return;
    const marker = claim.gt?.footnote_marker ? `fn${claim.gt.footnote_marker}` : claim.key;
    const triageBits = claim.triage
      ? ` triage=${claim.triage.status}${claim.triage.invented_tokens ? ` invented:${claim.triage.invented_tokens}` : ''}`
      : '';
    const reason = `study workbench (${state.corpus}/${state.slug} ${marker}): verdict=${claim.verdict};${triageBits}`.slice(0, 490);
    const ok = await confirmDialog({
      title: 'Flag conversion issue',
      message: `File the source book into the bad-conversion queue (/maintainer/conversion)?\n\n${reason}`,
      confirmLabel: 'Flag it',
    });
    if (!ok) return;
    btn.disabled = true;
    const { status, data } = await api.flagConversion(state.corpus, state.slug, reason, claim.key);
    btn.disabled = false;
    if (status !== 200 || !data.ok) {
      flash(wrap, data.error ?? `Flag failed (${status})`);
      return;
    }
    const done = el('p', 'st-muted');
    const a = el('a', undefined, '/maintainer/conversion');
    a.setAttribute('href', '/maintainer/conversion');
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener');
    done.append(data.updated ? '✓ Added to the existing open flag — see ' : '✓ Flagged — see ', a);
    btn.replaceWith(done);
  });
  wrap.append(btn);
  return wrap;
}

/**
 * How this corpus copy came to exist — the reviewer's context. A book built
 * by the legacy export-and-reimport round-trip has citation anchors that were
 * RE-DERIVED from plain text, not the ones the product produced, so a mislink
 * there may be an artifact of the round-trip rather than a product defect.
 */
function bookContextLine(): HTMLElement {
  const p = state.payload;
  const wrap = el('p', 'st-bookcontext');
  if (!p) return wrap;
  wrap.append(el('span', 'st-badge st-pathway', `pathway: ${p.pathway}`));
  const built = p.source_markdown ?? 'unknown';
  const roundTripped = built.startsWith('exported-from-nodes') && !built.includes('anchors preserved');
  wrap.append(
    el('span', roundTripped ? 'st-conv-warn' : 'st-muted',
      roundTripped
        ? ` corpus copy: ${built} — anchors were RE-DERIVED from plain text, not the live book's`
        : ` corpus copy: ${built}`),
  );
  return wrap;
}

/**
 * Claims the model did NOT write, and what that means for reading the verdict. An 'llm' claim
 * gets no note — it is the default, and labelling it would just be noise on every row.
 */
const CLAIM_SOURCE_NOTES: Record<string, string> = {
  span_scoped:
    'Scoped by us: the model returned a claim reaching across a neighbouring citation into '
    + "material that citation answers for, so this is the span THIS citation's marker sits in.",
  span_fallback:
    'Our own span: the model could not reproduce the sentence verbatim, so the deterministic '
    + 'span was used rather than dropping the citation from review.',
  span_backfill:
    'Our own span: the model never mentioned this citation, so the deterministic span was used '
    + 'rather than leaving it unreviewed.',
};

function section(title: string, body: string): HTMLElement {
  const sec = el('section', 'st-section');
  sec.append(el('h3', undefined, title), el('p', undefined, body));
  return sec;
}

// ----------------------------------------------------------------- evidence

/**
 * The quotes behind a human verdict.
 *
 * A label on its own is an assertion, and "we checked this citation by hand" is
 * the first thing a reader of the paper probes. These fields are what make it
 * showable — kept deliberately small (a capped textarea and a locator line) so
 * evidencing a closed-access source stays selective quotation.
 *
 * Built as one shared unit because it appears in TWO places that must behave
 * identically: the verdict form, and the saved verdict's "Add / Edit evidence".
 */
function evidenceFields(existing: Adjudication | null): {
  wrap: HTMLElement;
  textarea: HTMLTextAreaElement;
  locator: HTMLInputElement;
  value: () => string | null;
  locatorValue: () => string | null;
} {
  const wrap = el('div', 'st-evidence-fields');

  const textarea = el('textarea', 'st-note st-evidence') as HTMLTextAreaElement;
  textarea.rows = 6;
  textarea.maxLength = EVIDENCE_MAX_CHARS;
  textarea.placeholder = EVIDENCE_PLACEHOLDER_DEFAULT;
  textarea.value = existing?.evidence ?? '';
  // The id is how the prefill buttons find whichever copy of this is on screen
  // (the first-verdict form and the saved-verdict editor are never both open).
  textarea.id = 'st-evidence';

  const count = el('p', 'st-charcount');
  const refreshCount = (): void => {
    const n = textarea.value.length;
    count.textContent = `${n} / ${EVIDENCE_MAX_CHARS}`;
    count.classList.toggle('st-charcount-near', n > EVIDENCE_MAX_CHARS * 0.9);
  };
  textarea.addEventListener('input', refreshCount);
  refreshCount();

  const locator = el('input', 'st-note st-locator') as HTMLInputElement;
  locator.type = 'text';
  locator.maxLength = 200;
  locator.placeholder = 'Where in the source (optional) — "p. 412", "0:01–1:51, auto-captions"';
  locator.value = existing?.evidence_locator ?? '';

  wrap.append(
    el('p', 'st-axis-label', 'Evidence — what did YOU read that settles this?'),
    textarea,
    count,
    prefillRow(textarea, locator),
    locator,
    el(
      'p',
      'st-evidence-hint',
      'Short, selective quotation only — enough to show what you judged, never a copy of the source.',
    ),
  );

  return {
    wrap,
    textarea,
    locator,
    value: () => textarea.value.trim() || null,
    locatorValue: () => locator.value.trim() || null,
  };
}

/**
 * Capture what the reviewer has SELECTED, rather than making them retype it.
 *
 * The selection may be in the page (the passages, the claim text) or inside the
 * pane iframe — both the Hyperlit render and the extracted-source render are
 * same-origin, so their selection is readable. The browser's PDF viewer is NOT,
 * which is why the failure is explained rather than silent.
 */
function prefillRow(textarea: HTMLTextAreaElement, locator: HTMLInputElement): HTMLElement {
  const row = el('div', 'st-btnrow');
  const useSelection = el('button', 'st-useevidence', '⤓ use selection');
  useSelection.type = 'button';
  useSelection.title = 'Append whatever text is currently selected — in this page or in the source pane';
  useSelection.addEventListener('click', () => {
    const picked = currentSelectionText();
    if (!picked) {
      flash(
        row,
        'Nothing selected. Select text in the page or the source pane first — a PDF in the viewer cannot be read this way, so quote it by hand.',
      );
      return;
    }
    appendEvidence(textarea, picked);
    if (!locator.value.trim()) {
      const suggested = suggestedLocator();
      if (suggested) locator.value = suggested;
    }
  });
  row.append(useSelection);
  return row;
}

/** The selection from the page, else from the same-origin pane iframe. */
function currentSelectionText(): string {
  const inPage = window.getSelection()?.toString().trim();
  if (inPage) return inPage;

  // getElementById, not byId: byId THROWS on a missing node, and "the pane is
  // not open" is an ordinary state here, not a broken page.
  const frame = document.getElementById('st-pdf-frame') as HTMLIFrameElement | null;
  try {
    // Cross-origin (or the PDF viewer) throws or yields nothing — both mean
    // "cannot read this", and the caller explains that to the reviewer.
    return frame?.contentWindow?.getSelection()?.toString().trim() ?? '';
  } catch {
    return '';
  }
}

/** A locator we can honestly infer from the pane the reviewer is reading. */
function suggestedLocator(): string | null {
  if (paneView === 'source') return 'extracted source';
  if (paneView === 'hyperlit') return 'study copy';
  return null;
}

/**
 * Append one quotation, keeping the "one quote per paragraph" shape.
 *
 * Truncation is REPORTED rather than silent: evidence that was quietly cut is
 * worse than no evidence, because it still reads as a complete quotation.
 */
function appendEvidence(textarea: HTMLTextAreaElement, text: string): void {
  const quoted = `“${text.replace(/\s+/g, ' ').trim()}”`;
  const separator = textarea.value.trim() ? '\n\n' : '';
  const room = EVIDENCE_MAX_CHARS - textarea.value.length - separator.length;
  if (room <= 0) {
    flash(textarea.parentElement ?? textarea, `Evidence is full (${EVIDENCE_MAX_CHARS} characters) — trim it first.`);
    return;
  }
  const fits = quoted.length <= room;
  textarea.value += separator + (fits ? quoted : quoted.slice(0, room - 1) + '…');
  textarea.dispatchEvent(new Event('input'));
  if (!fits) {
    flash(textarea.parentElement ?? textarea, `Quote was truncated to fit the ${EVIDENCE_MAX_CHARS}-character cap.`);
  }
}

/** Does this label owe evidence? Mirrors AdjudicationStore::evidenceExpectedLabels(). */
function labelExpectsEvidence(label: string | null | undefined): boolean {
  return ['intact', 'verified_intact', 'fabricated_reference', 'source_swap', 'claim_distortion'].includes(
    label ?? '',
  );
}

// ------------------------------------------------------------- adjudication

/**
 * A verdict the reviewer just took back with Undo, keyed by claim key.
 *
 * Undo deletes the stored record, and it used to take the reviewer's work with it — the quotes,
 * the found URL, the note — when all they wanted was a different label. The retracted record is
 * kept here so the form reopens holding everything it held. In memory only: a reload is the
 * point at which an Undo becomes final.
 */
const retractedDrafts = new Map<string, Adjudication>();

/**
 * The verdict section. With a saved verdict it shows that verdict; otherwise the form.
 * `editing` reopens the form OVER a saved verdict, prefilled from it — nothing is written until
 * Save, which replaces the record wholesale (AdjudicationStore::put), so a changed label cannot
 * leave the old cause or scope behind.
 */
function adjudicationForm(claim: ClaimRow, editing = false): HTMLElement {
  const form = el('section', 'st-section st-adjudicate');
  const heading = el('h3', undefined, 'Your verdict ');
  const helpBtn = el('button', 'st-verdict-help-toggle', '?');
  helpBtn.type = 'button';
  helpBtn.setAttribute('aria-expanded', 'false');
  heading.append(helpBtn);
  form.append(heading);

  const help = el('div', 'st-verdict-help');
  help.hidden = true;
  help.append(el('p', undefined,
    'Two separate questions. 1 — is the cited work REAL, and cited correctly? 2 — does that work '
    + 'SUPPORT the claim? Your two answers are stored as given. The scored label (what the AI is '
    + 'measured against on Apply) is worked out from them and shown above the Save button — you '
    + 'never pick it. CAUSE is separate and optional: when the AI got this one wrong, whose '
    + 'failure was it? It feeds system improvement, never the score.'));
  const dl = el('dl');
  dl.append(el('dt', 'st-help-group', '1 · Is the reference real?'));
  for (const r of REFERENCES) dl.append(el('dt', undefined, r.text), el('dd', undefined, r.desc));
  dl.append(el('dt', 'st-help-group', '2 · Does it support the claim?'));
  for (const sc of SUPPORTED_SCOPES) dl.append(el('dt', undefined, sc.text), el('dd', undefined, sc.desc));
  dl.append(el('dt', 'st-help-group', 'Cause'));
  for (const c of CAUSES) {
    dl.append(el('dt', undefined, c.text.split(' — ')[0]), el('dd', undefined, c.desc));
  }
  help.append(dl);
  helpBtn.addEventListener('click', () => {
    help.hidden = !help.hidden;
    helpBtn.setAttribute('aria-expanded', String(!help.hidden));
  });
  form.append(help);

  if (claim.adjudication && !editing) {
    form.append(currentAdjudication(claim, claim.adjudication));
    return form;
  }
  // What the form opens holding: the saved verdict being changed, else one just undone.
  const draft: Adjudication | null = claim.adjudication ?? retractedDrafts.get(claim.key) ?? null;

  let chosenReference: string | null = null;
  const chosenErrors = new Set<string>();
  let chosenScope: string | null = null;
  let chosenCause: string | null = null;

  // ---- Question 1: is the cited work real, and cited correctly?
  const referenceRow = el('div', 'st-btnrow');
  const referenceButtons = REFERENCES.map((r) => {
    const b = el('button', 'st-choice', r.text);
    b.type = 'button';
    b.title = r.desc; // hover tooltip; full list under the ? button
    b.addEventListener('click', () => {
      chosenReference = r.value;
      referenceButtons.forEach((x) => x.classList.toggle('st-choice-on', x === b));
      refresh();
    });
    return b;
  });
  referenceRow.append(...referenceButtons);
  const pickReference = (value: string): void => {
    referenceButtons[REFERENCES.findIndex((r) => r.value === value)]?.click();
  };

  // What is wrong, for "real — but cited wrongly". Shown only then.
  const errorsRow = el('div', 'st-btnrow st-reference-errors');
  errorsRow.append(el('span', 'st-muted', 'What does the citation get wrong?'));
  const errorButtons = REFERENCE_ERRORS.map((e) => {
    const b = el('button', 'st-choice', e.text);
    b.type = 'button';
    b.addEventListener('click', () => {
      if (chosenErrors.has(e.value)) chosenErrors.delete(e.value);
      else chosenErrors.add(e.value);
      b.classList.toggle('st-choice-on', chosenErrors.has(e.value));
      refresh();
    });
    return b;
  });
  errorsRow.append(...errorButtons);
  // What it SHOULD have said, and how the reviewer knows — right under the thing it corrects.
  const correction = el('textarea', 'st-note st-reference-correction') as HTMLTextAreaElement;
  correction.rows = 2;
  correction.maxLength = 500;
  correction.placeholder = 'What should it say, and how do you know? — e.g. "Report is by the Standing '
    + 'Committee on Education and Employment (title page)"';
  const pickErrors = (values: string[]): void => {
    REFERENCE_ERRORS.forEach((e, i) => {
      if (values.includes(e.value) !== chosenErrors.has(e.value)) errorButtons[i]?.click();
    });
  };

  // ---- Question 2: does the work support the claim? Only meaningful for a real work.
  const scopeRow = el('div', 'st-btnrow st-disabled');
  const scopeButtons = SUPPORTED_SCOPES.map((sc) => {
    const b = el('button', 'st-choice st-choice-scope', sc.text);
    b.type = 'button';
    b.title = sc.desc;
    b.addEventListener('click', () => {
      chosenScope = chosenScope === sc.value ? null : sc.value;
      scopeButtons.forEach((x) => x.classList.toggle('st-choice-on', x === b && chosenScope === sc.value));
      refresh();
    });
    return b;
  });
  scopeRow.append(...scopeButtons);

  // Refines "supports none of it": the claim is real, but it belongs to another work.
  const otherWorkWrap = el('label', 'st-refexists');
  const otherWork = el('input') as HTMLInputElement;
  otherWork.type = 'checkbox';
  otherWork.addEventListener('change', () => refresh());
  otherWorkWrap.append(otherWork, ' the claim actually comes from a DIFFERENT work (source swap)');

  // ---- Cause (optional, never scored).
  const causeRow = el('div', 'st-btnrow st-disabled');
  // Only the causes that can actually apply to THIS claim — see relevantCauses.
  const relevant = relevantCauses(claim);
  const causeButtons = CAUSES.map((c) => {
    const b = el('button', 'st-choice st-choice-cause', c.text);
    b.type = 'button';
    b.title = c.desc;
    if (!relevant.has(c.value)) {
      b.classList.add('st-choice-offtopic');
      b.hidden = true;
    }
    b.addEventListener('click', () => {
      chosenCause = chosenCause === c.value ? null : c.value;
      causeButtons.forEach((x) => x.classList.toggle('st-choice-on', x === b && chosenCause === c.value));
    });
    return b;
  });
  causeRow.append(...causeButtons);

  // The escape hatch. A reviewer who has READ the source can know something the record does not
  // show, so the narrowed set must never be a cage — just a sane default.
  const hiddenCount = causeButtons.filter((b) => b.hidden).length;
  if (hiddenCount > 0) {
    const more = el('button', 'st-choice st-choice-more', `+${hiddenCount} other causes`);
    more.type = 'button';
    more.title = 'Causes that do not fit what the record says happened to this claim — available if you know better.';
    more.addEventListener('click', () => {
      const nowHidden = causeButtons.some((b) => b.hidden);
      causeButtons.forEach((b) => {
        if (b.classList.contains('st-choice-offtopic')) b.hidden = !nowHidden;
      });
      more.textContent = nowHidden ? 'show fewer causes' : `+${hiddenCount} other causes`;
    });
    causeRow.append(more);
  }

  const foundUrl = el('input', 'st-note st-found-url') as HTMLInputElement;
  foundUrl.type = 'url';
  const URL_PLACEHOLDER_DEFAULT =
    'URL where YOU found the source (optional) — each one becomes a resolver test case';
  foundUrl.placeholder = URL_PLACEHOLDER_DEFAULT;

  /**
   * The form's wording assumes a REAL source, which reads wrong the moment question 1 is
   * answered "fabricated" — there is no source, so the URL and quotes are COUNTER-EVIDENCE:
   * the TOC/index/other review the operator checked, backing their claim ABOUT the source.
   * The stored fields already mean exactly that (evidence = what the REVIEWER read) — this
   * just makes the form say so.
   */
  const applyReferenceCopy = (noSource: boolean): void => {
    foundUrl.placeholder = noSource
      ? 'URL of what YOU checked (optional) — the TOC / index / review showing the work does not exist, NOT the cited work'
      : URL_PLACEHOLDER_DEFAULT;
    evidence.textarea.placeholder = noSource
      ? 'Quotes from what YOU read that settles this — counter-evidence (journal TOC, index, '
        + 'another review documenting the fabrication), since there is no source to quote.'
      : EVIDENCE_PLACEHOLDER_DEFAULT;
  };

  const note = el('textarea', 'st-note') as HTMLTextAreaElement;
  note.placeholder = 'Optional note — your reasoning; saved with the verdict, lands in dataset.csv';
  note.rows = 2;

  const evidence = evidenceFields(draft);

  // The label the two answers produce, in the open — nothing about scoring is implicit.
  const scoredLine = el('p', 'st-scored-line');
  const saveBtn = el('button', 'st-save', 'Save verdict') as HTMLButtonElement;
  saveBtn.type = 'button';
  saveBtn.disabled = true;

  /** One place decides what is enabled, what is still owed, and what the answers score as. */
  const refresh = (): void => {
    const real = isRealReference(chosenReference);
    const wrongDetails = chosenReference === 'details_wrong';
    errorsRow.hidden = !wrongDetails;
    correction.hidden = !wrongDetails;
    scopeRow.classList.toggle('st-disabled', !real);
    otherWorkWrap.hidden = !(real && chosenScope === 'none');
    causeRow.classList.toggle('st-disabled', !chosenReference);
    applyReferenceCopy(chosenReference === 'fabricated');

    const owed = !chosenReference ? 'Answer question 1.'
      : wrongDetails && chosenErrors.size === 0 ? 'Tick what the citation gets wrong.'
        : real && !chosenScope ? 'Answer question 2.'
          : null;
    saveBtn.disabled = owed !== null;
    if (owed || !chosenReference) {
      scoredLine.textContent = owed;
      return;
    }
    const label = deriveLabel(chosenReference, real ? chosenScope : null, otherWork.checked);
    scoredLine.textContent = `Scored as: ${SCORING[label] ?? label}`;
  };

  // An Ibid cites the same WORK as its antecedent, so a verdict already saved there
  // settles question 1 for this row — only question 2 is fresh judging. The antecedent's
  // answer is pre-selected (one click for a no-such-work verdict, which also carries its
  // cause); nothing saves until the operator hits Save verdict.
  let anteBanner: HTMLElement | null = null;
  const inherited = inheritedSourceVerdict(claim);
  if (inherited) {
    const { ante, adj, via } = inherited;
    const anteId = ante.gt?.gt_id ?? ante.referenceId ?? 'antecedent';
    anteBanner = el('div', 'st-ante-banner');
    // The named verdict is one click away — inheriting is a judgement call, and the
    // operator should be able to re-read what they decided there before taking it.
    const intro = el('p');
    intro.append(
      via === 'antecedent'
        ? "This Ibid's source was already adjudicated on its antecedent: "
        : 'Another citation of this same work was already adjudicated: ',
    );
    intro.append(claimLinkEl(ante, `${anteId}: ${answersText(adj)} ↗`,
      'Re-check that verdict before inheriting it'));
    anteBanner.append(intro);

    if (adj.reference === 'fabricated' || adj.reference === 'unverifiable') {
      const refText = REFERENCES.find((r) => r.value === adj.reference)?.text ?? adj.reference;
      const btn = el('button', 'st-choice st-ante-inherit', `inherit “${refText}”`);
      btn.type = 'button';
      btn.title = 'Pre-selects that verdict’s answer to question 1 and its cause. The antecedent’s '
        + 'evidence counts for this row automatically — a fabrication verdict is about the WORK, so '
        + 'its proof holds for every citation of it. Nothing saves until you click Save verdict.';
      btn.addEventListener('click', () => {
        pickReference(adj.reference);
        if (adj.cause && chosenCause !== adj.cause) {
          const cb = causeButtons[CAUSES.findIndex((c) => c.value === adj.cause)];
          if (cb) {
            cb.hidden = false;
            cb.click();
          }
        }
        if (!note.value.trim()) {
          note.value = via === 'antecedent'
            ? `source identity inherited from antecedent ${anteId} (Ibid)`
            : `source identity inherited from ${anteId} (same work, cited independently)`;
        }
        // Evidence is NOT copied here: the saved verdict RESOLVES to the antecedent's
        // quotes at read time (inheritedEvidence) and the apply step writes them into
        // ground truth with provenance — the proof lives once, on the verdict that
        // established it, and this row still counts as evidenced for the research.
      });
      anteBanner.append(btn);
    } else if (isRealReference(adj.reference) && !draft) {
      // Whether the work is real — and whether it is cited correctly — is a fact about the
      // WORK, so it carries. What THIS claim is supported by does not.
      pickReference(adj.reference);
      pickErrors(adj.reference_errors ?? []);
      anteBanner.append(el('p', 'st-muted',
        'Whether the work is real is settled by that verdict — question 1 is pre-filled (change '
        + 'it if this citation differs); judge what THIS claim is supported by.'));
    }
  }

  saveBtn.addEventListener('click', async () => {
    if (!chosenReference || !state.slug) return;
    const real = isRealReference(chosenReference);
    form.classList.add('st-busy');
    const { status, data } = await api.adjudicate(state.corpus, state.slug, {
      key: claim.key,
      reference: chosenReference,
      reference_errors: chosenReference === 'details_wrong' ? [...chosenErrors] : [],
      reference_correction: chosenReference === 'details_wrong' ? (correction.value.trim() || null) : null,
      supported_scope: real ? chosenScope : null,
      from_other_work: real && chosenScope === 'none' && otherWork.checked,
      cause: chosenCause,
      note: note.value.trim() || null,
      found_url: foundUrl.value.trim() || null,
      // Answered in the Resolved Source panel; held there until a verdict exists to carry it.
      // Changing a saved verdict keeps the answer already on it (read at save time — the panel
      // writes straight onto the saved record, so it may have changed since the form opened).
      source_match: !systemSuppliedUrl(claim) ? null
        : claim.adjudication ? (claim.adjudication.source_match ?? null)
          : (pendingSourceMatch.get(claim.key) ?? null),
      evidence: evidence.value(),
      evidence_locator: evidence.locatorValue(),
      referenceId: claim.referenceId,
      run_id: state.payload?.run_id ?? null,
    });
    form.classList.remove('st-busy');
    if (status !== 200 || !data.ok || !data.adjudication) {
      flash(form, data.error ?? `Save failed (${status})`);
      log.error(`adjudicate failed: ${data.error ?? status}`, '/workbenches/study/main.ts');
      return;
    }
    // A changed verdict replaces one already counted.
    if (!claim.adjudication) bumpAdjudicatedCount(1);
    claim.adjudication = data.adjudication;
    retractedDrafts.delete(claim.key);
    renderList();
    renderApplyBar();
    form.replaceChildren(el('h3', undefined, 'Your verdict'), currentAdjudication(claim, data.adjudication));
  });

  // Reopen holding what the verdict held. AFTER the inherit banner, so the draft's own
  // answers win over anything the banner pre-selected.
  if (draft) {
    pickReference(draft.reference);
    pickErrors(draft.reference_errors ?? []);
    correction.value = draft.reference_correction ?? '';
    if (draft.supported_scope && isRealReference(draft.reference)) {
      scopeButtons[SUPPORTED_SCOPES.findIndex((sc) => sc.value === draft.supported_scope)]?.click();
    }
    otherWork.checked = draft.from_other_work === true;
    const cb = draft.cause ? causeButtons[CAUSES.findIndex((c) => c.value === draft.cause)] : undefined;
    if (cb) {
      cb.hidden = false; // it may be outside the narrowed set — it was chosen, so show it
      cb.click();
    }
    foundUrl.value = draft.found_url ?? '';
    note.value = draft.note ?? '';
    form.append(el('p', 'st-muted', claim.adjudication
      ? 'Changing your saved verdict — it stays as it is until you save.'
      : 'You undid this verdict. Its answers, evidence, URL and note are still here — save to record it again.'));
  }
  refresh();

  const actions = el('div', 'st-btnrow');
  actions.append(saveBtn);
  if (claim.adjudication) {
    const cancel = el('button', 'st-undo', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => form.replaceWith(adjudicationForm(claim)));
    actions.append(cancel);
  }

  if (anteBanner) form.append(anteBanner);
  form.append(
    el('p', 'st-axis-label', '1 · Is the reference real? — does the cited work exist, and is it cited correctly?'),
    referenceRow,
    errorsRow,
    correction,
    el('p', 'st-axis-label', '2 · Does it support the claim? — only asked when the work is real:'),
    scopeRow,
    otherWorkWrap,
    el('p', 'st-axis-label', "Cause — if the AI got this one wrong, whose failure was it? (optional, not scored):"),
    causeRow,
    foundUrl,
    note,
    evidence.wrap,
    scoredLine,
    actions,
  );
  return form;
}

/** A saved verdict's two answers, in the reviewer's words: "real — cited correctly · supports PART of the claim". */
function answersText(adj: Adjudication): string {
  const ref = REFERENCES.find((r) => r.value === adj.reference)?.text ?? adj.reference;
  const wrong = adj.reference === 'details_wrong' && adj.reference_errors?.length
    ? ` (${adj.reference_errors.join(', ')})` : '';
  if (!isRealReference(adj.reference)) return ref;
  const scope = adj.supported_scope
    ? (SUPPORTED_SCOPES.find((s) => s.value === adj.supported_scope)?.text ?? adj.supported_scope)
      + (adj.from_other_work ? ' — claim is from a different work' : '')
    : 'support NOT answered';
  return `${ref}${wrong} · ${scope}`;
}

function currentAdjudication(claim: ClaimRow, adj: Adjudication): HTMLElement {
  const wrap = el('div', 'st-current');
  // A verdict recorded against an OLDER run than the book's current one —
  // fine for citation-truth verdicts, but a stale citation_mislink describes
  // anchors that a reimport likely fixed.
  const srcBit = adj.source_match === 'same_work' ? ' · right URL ✓'
    : adj.source_match === 'different_work' ? ' · wrong URL ✗' : '';
  const stale = adj.run_id && state.payload?.run_id && adj.run_id !== state.payload.run_id;
  const staleBit = stale ? (adj.cause === 'citation_mislink' ? ' · ⚠ OLDER RUN — re-check' : ' · (older run)') : '';
  // The two answers first, as given; then what they score as; then the optional cause.
  const line = `${answersText(adj)}${srcBit}${staleBit} — ${adj.adjudicated_by}`;
  wrap.append(el('p', 'st-badge st-done', `✓ ${line}`));
  wrap.append(el('p', 'st-muted',
    `Scored as: ${SCORING[adj.label] ?? adj.label}${adj.cause ? ` · cause: ${adj.cause.replace(/_/g, ' ')}` : ''}`));
  if (adj.reference_correction) {
    wrap.append(el('p', 'st-muted', `Should say: ${adj.reference_correction}`));
  }
  if (isRealReference(adj.reference) && !adj.supported_scope) {
    // Recorded before question 2 existed (or by a caller that skipped it). It scores as
    // "supports the claim" — say so, rather than let an unanswered question read as a yes.
    wrap.append(el('p', 'st-conv-warn',
      '⚠ Question 2 was never answered for this verdict — it is being scored as if the work supports the claim. Change verdict to answer it.'));
  }
  if (adj.found_url) {
    const p = el('p', 'st-muted');
    const a = el('a', undefined, adj.found_url);
    a.setAttribute('href', adj.found_url);
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener');
    p.append('found at: ', a);
    wrap.append(p);
  }
  if (adj.note) wrap.append(el('p', 'st-muted', adj.note));
  wrap.append(evidenceBlock(claim, adj, wrap));
  // The way to fix a verdict: reopen the form over it. Nothing is deleted on the way.
  const change = el('button', 'st-undo', 'Change verdict');
  change.type = 'button';
  change.title = 'Reopen the form with this verdict filled in — evidence, URL and note are kept.';
  change.addEventListener('click', () => {
    wrap.closest('.st-adjudicate')?.replaceWith(adjudicationForm(claim, true));
  });
  wrap.append(change);

  const undo = el('button', 'st-undo', 'Undo');
  undo.type = 'button';
  undo.title = 'Remove this verdict. The form reopens with what it held, until you reload.';
  undo.addEventListener('click', async () => {
    if (!state.slug) return;
    const { status, data } = await api.retract(state.corpus, state.slug, claim.key);
    if (status !== 200 || !data.ok) {
      flash(wrap, data.error ?? `Undo failed (${status})`);
      return;
    }
    // Keep what was retracted: read from the claim, which the evidence and URL-check saves
    // keep current (`adj` is the record this block was first drawn from).
    const retracted = claim.adjudication ?? adj;
    retractedDrafts.set(claim.key, retracted);
    pendingSourceMatch.set(claim.key, retracted.source_match ?? null);
    claim.adjudication = null;
    bumpAdjudicatedCount(-1);
    renderList();
    renderApplyBar();
    renderDetail(claim);
  });
  wrap.append(undo);
  return wrap;
}

/**
 * The evidence on an ALREADY-SAVED verdict: shown when present, promptable when
 * missing, editable either way, without reopening the whole verdict. It is how
 * the verdicts recorded before the field existed get backfilled, and there are ~50 of those.
 */
function evidenceBlock(claim: ClaimRow, adj: Adjudication, host: HTMLElement): HTMLElement {
  const block = el('div', 'st-evidence-block');

  const inherited = adj.evidence ? null : inheritedEvidence(claim);
  if (adj.evidence) {
    // pre-wrap in CSS, so paragraphs survive without innerHTML (house rule).
    block.append(el('blockquote', 'st-evidence-quote', adj.evidence));
    const meta = [adj.evidence_locator, adj.evidenced_by ? `evidenced by ${adj.evidenced_by}` : null]
      .filter(Boolean)
      .join(' · ');
    if (meta) block.append(el('p', 'st-muted', meta));
  } else if (inherited) {
    // The verdict inherits its source from an adjudicated antecedent, so it inherits the
    // PROOF too — same work, same evidence. Shown resolved (not copied) so the quote
    // lives once, on the verdict that established it.
    block.append(el('blockquote', 'st-evidence-quote', inherited.quote));
    const meta = el('p', 'st-muted');
    meta.append(inherited.locator ? `${inherited.locator} · ` : '');
    meta.append(claimLinkEl(inherited.ante, `inherited from ${inherited.anteId} ↗`,
      'The verdict this evidence was recorded on'));
    block.append(meta);
  } else if (labelExpectsEvidence(adj.label)) {
    // Only nag where a quotation is actually possible: the non-scored labels
    // are exempt precisely because there is nothing to quote.
    block.append(el('p', 'st-conv-warn', '⚠ No evidence recorded — this label is an assertion until it has one.'));
  }

  const toggle = el('button', 'st-undo', adj.evidence ? 'Edit evidence' : 'Add evidence');
  toggle.type = 'button';
  toggle.addEventListener('click', () => {
    toggle.remove();
    block.append(evidenceEditor(claim, adj, host));
  });
  block.append(toggle);

  return block;
}

function evidenceEditor(claim: ClaimRow, adj: Adjudication, host: HTMLElement): HTMLElement {
  const editor = el('div', 'st-evidence-editor');
  const fields = evidenceFields(adj);

  const save = el('button', 'st-save', 'Save evidence') as HTMLButtonElement;
  save.type = 'button';
  save.addEventListener('click', async () => {
    if (!state.slug) return;
    editor.classList.add('st-busy');
    const { status, data } = await api.putEvidence(state.corpus, state.slug, {
      key: claim.key,
      evidence: fields.value(),
      evidence_locator: fields.locatorValue(),
    });
    editor.classList.remove('st-busy');
    if (status !== 200 || !data.ok || !data.adjudication) {
      flash(editor, data.error ?? `Save failed (${status})`);
      log.error(`evidence save failed: ${data.error ?? status}`, '/workbenches/study/main.ts');
      return;
    }
    claim.adjudication = data.adjudication;
    // Re-render only this verdict block. renderDetail would reset the pane's
    // scroll, and the reviewer is usually deep in a long source when they
    // finish quoting from it. NOT a bumpAdjudicatedCount: that counter means
    // adjudications, and this added none.
    host.replaceWith(currentAdjudication(claim, data.adjudication));
    renderList();
  });

  editor.append(fields.wrap, save);
  return editor;
}

function bumpAdjudicatedCount(delta: number): void {
  if (state.payload) state.payload.counts.adjudicated += delta;
}

// ---------------------------------------------------------------- apply bar

function renderApplyBar(): void {
  const bar = byId<HTMLDivElement>('st-applybar');
  const payload = state.payload;
  if (!payload || payload.counts.adjudicated === 0) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  byId<HTMLSpanElement>('st-apply-summary').textContent =
    `${payload.counts.adjudicated} adjudication(s) recorded${payload.frozen ? ' — corpus FROZEN, apply disabled' : ''}`;
  const btn = byId<HTMLButtonElement>('st-apply-btn');
  btn.disabled = payload.frozen;
  btn.onclick = async () => {
    if (!state.slug) return;
    const ok = await confirmDialog({
      title: 'Apply to ground truth',
      message: 'Fold adjudicated labels into ground_truth.json? Every change is a diffable edit to the committed corpus.',
      confirmLabel: 'Apply',
    });
    if (!ok) return;
    btn.disabled = true;
    const { status, data } = await api.apply(state.corpus, state.slug);
    btn.disabled = false;
    if (status !== 200 || !data.ok) {
      flash(bar, data.error === 'corpus_frozen' ? 'Corpus is frozen.' : (data.error ?? `Apply failed (${status})`));
      return;
    }
    const stale = data.stale_mislinks ?? [];
    byId<HTMLSpanElement>('st-apply-summary').textContent =
      `Applied ${data.applied} label(s) to ground truth — re-run citation:study:report ${state.corpus}.`
      + (stale.length
        ? ` ⚠ ${stale.length} citation-mislink verdict(s) from an OLDER run NOT applied (the phantom anchors were likely fixed by reimport — re-check): ${stale.join(', ')}`
        : '');
  };
}

// -------------------------------------------------------------- source pane
// Two views in one pane: the ORIGINAL PDF (browser viewer + server-side text
// search) and HYPERLIT (the study copy's stored nodes rendered by the
// admin-gated /render endpoint — the real reader can't frame the study copy:
// it is deliberately RLS-private, and several source books are too). The
// Hyperlit view is where "jump to this citation" is exact: claims carry the
// study copy's node_ids, which are the render's anchors.

type PaneView = 'pdf' | 'hyperlit' | 'source';

let paneView: PaneView = 'pdf';
let pdfAvailable = false;

function pdfUrl(): string | null {
  const bookId = state.payload?.source_book_id;
  return bookId ? `/api/maintainer/conversion/original/${encodeURIComponent(bookId)}` : null;
}

function hyperlitUrl(): string | null {
  if (!state.slug || state.payload?.run_status !== 'completed') return null;
  return `/api/maintainer/study/render/${encodeURIComponent(state.slug)}?corpus=${encodeURIComponent(state.corpus)}`;
}

/**
 * The SELECTED claim's resolved source, rendered from its stored nodes.
 *
 * Per CLAIM, not per book — each citation resolves to its own source, so this view follows the
 * selection the way the Hyperlit anchor does. Null when the claim resolved nothing, which is
 * what disables the tab.
 */
function sourceUrl(claim: ClaimRow | null): string | null {
  const bookId = claim?.source.book_id;
  return bookId ? `/api/maintainer/study/source/${encodeURIComponent(bookId)}` : null;
}

function setupPdfPane(): void {
  const pane = byId<HTMLElement>('st-pdf-pane');
  const original = pdfUrl();
  const hyperlit = hyperlitUrl();
  // A resolved source is reason enough to keep the pane: an adopted raw-file corpus entry has
  // no original PDF, and reading what we extracted must not depend on the article's own copy.
  const anySource = (state.payload?.claims ?? []).some((c) => !!c.source.book_id);
  if (!original && !hyperlit && !anySource) {
    pane.hidden = true;
    return;
  }
  pane.hidden = false;
  pdfAvailable = false;

  if (original) {
    // HEAD-probe: a source book without original.pdf (web imports) keeps the
    // pane but disables the Original view instead of hiding everything.
    void fetch(original, { method: 'HEAD', credentials: 'include' }).then(drainResponse).then((res) => {
      pdfAvailable = res.ok;
      if (!res.ok && paneView === 'pdf') setPaneView('hyperlit');
      else setPaneView(paneView);
    });
  } else {
    setPaneView(hyperlit ? 'hyperlit' : 'source');
  }

  byId<HTMLButtonElement>('st-view-pdf').onclick = () => setPaneView('pdf');
  byId<HTMLButtonElement>('st-view-hyperlit').onclick = () => setPaneView('hyperlit');
  byId<HTMLButtonElement>('st-view-source').onclick = () => setPaneView('source');
  const go = byId<HTMLButtonElement>('st-pdf-go');
  const query = byId<HTMLInputElement>('st-pdf-query');
  go.onclick = () => void runSearch();
  query.onkeydown = (e) => {
    if (e.key === 'Enter') void runSearch();
  };
}

/** One search box, routed to whichever view is active. */
function runSearch(): Promise<void> {
  return paneView === 'pdf' ? runPdfSearch() : runNodeSearch();
}

/**
 * Which tabs are available, and which is current.
 *
 * SEPARATE from setPaneView because availability depends on the SELECTED CLAIM — Source resolves
 * per claim — so it has to re-run on every selection, not only when the view changes. It didn't,
 * and the Source tab was permanently disabled: nothing is selected when the pane is first built,
 * and the Hyperlit branch of the selection handler jumped the frame without ever going through
 * setPaneView.
 */
function refreshPaneTabs(): void {
  const pdfBtn = byId<HTMLButtonElement>('st-view-pdf');
  const hlBtn = byId<HTMLButtonElement>('st-view-hyperlit');
  const srcBtn = byId<HTMLButtonElement>('st-view-source');
  pdfBtn.setAttribute('aria-selected', String(paneView === 'pdf'));
  hlBtn.setAttribute('aria-selected', String(paneView === 'hyperlit'));
  srcBtn.setAttribute('aria-selected', String(paneView === 'source'));
  pdfBtn.disabled = !pdfAvailable;
  hlBtn.disabled = !hyperlitUrl();
  srcBtn.disabled = !sourceUrl(selectedClaim());
  byId<HTMLElement>('st-extraction-flag').hidden = paneView !== 'source';
}

function setPaneView(view: PaneView): void {
  // Fall back rather than show an empty frame: a web-imported book has no PDF, a run that has
  // not completed has no study copy, and a claim that resolved nothing has no source.
  const sourceTarget = sourceUrl(selectedClaim());
  if (view === 'source' && !sourceTarget) view = hyperlitUrl() ? 'hyperlit' : 'pdf';
  if (view === 'pdf' && !pdfAvailable) view = 'hyperlit';
  if (view === 'hyperlit' && !hyperlitUrl()) view = 'pdf';
  paneView = view;
  refreshPaneTabs();

  // One search strip, three backends: pdf-search (pdftotext, page hits) in PDF view, and
  // node-search in the other two — against the study copy in Hyperlit, against the resolved
  // source's stored nodes in Source (else the box would answer about the wrong document).
  byId<HTMLInputElement>('st-pdf-query').placeholder =
    view === 'pdf' ? 'Search the PDF…'
      : view === 'source' ? 'Search the extracted source…'
        : 'Search the article…';
  byId<HTMLDivElement>('st-pdf-hits').replaceChildren();

  const frame = byId<HTMLIFrameElement>('st-pdf-frame');
  const target = view === 'pdf' ? pdfUrl()
    : view === 'source' ? sourceTarget
      : hyperlitAnchorUrl(selectedClaim());
  if (target && frame.getAttribute('data-view-url') !== target) {
    frame.setAttribute('data-view-url', target);
    navigateFrame(frame, target);
  }
}

function selectedClaim(): ClaimRow | null {
  return state.payload?.claims.find((c) => c.key === state.selectedKey) ?? null;
}

/**
 * Judge the EXTRACTION, beside the extraction. Mirrors
 * StudyConsoleController::EXTRACTION_VERDICTS.
 *
 * Seeing a bad scrape is worth little on its own — the value is the tally. Each verdict records
 * the URL's HOST, the grade WebTextAcquirer assigned and how many characters we kept, so
 * `citation:extraction-flags` can answer "which publishers does our extractor fail on, and did
 * it already know it had failed". `good` is offered too and is not decoration: without the
 * successes counted, a host's failure count has no denominator.
 */
const EXTRACTION_VERDICTS: Array<{ value: string; text: string; title: string }> = [
  { value: 'empty', text: 'Nothing', title: 'No body text at all' },
  { value: 'fragment', text: 'Only a bit of it', title: 'Real article text, but most of the article is missing' },
  // Stored as `furniture` — this codebase's word for a page's chrome (MainContentExtractor,
  // WebTextAcquirer). The BUTTON does not say "furniture": the reviewer needs to know which
  // failure they are looking at, not which term we file it under.
  { value: 'furniture', text: 'Nav/ads, not the article',
    title: 'Right page, wrong part of it — we kept the navigation, related-story rails, subscribe '
      + 'prompts or cookie notice instead of the body ("page furniture")' },
  { value: 'wrong_page', text: 'A different article',
    title: 'Not the cited work at all — the URL resolved to some other page' },
  { value: 'good', text: 'Looks right', title: 'The article, substantially complete — clears any open flag' },
];

function renderExtractionFlag(claim: ClaimRow | null): void {
  const box = byId<HTMLElement>('st-extraction-flag');
  const book = claim?.source.book_id;
  if (!book) {
    box.replaceChildren();
    return;
  }
  const row = el('div', 'st-flag-row');
  row.append(el('span', 'st-muted', 'This extraction is:'));
  const status = el('span', 'st-flag-status');

  EXTRACTION_VERDICTS.forEach((v) => {
    const b = el('button', 'st-undo', v.text);
    b.type = 'button';
    b.title = v.title;
    b.addEventListener('click', () => {
      void (async () => {
        row.querySelectorAll('button').forEach((x) => { (x as HTMLButtonElement).disabled = true; });
        status.className = 'st-flag-status st-muted';
        status.textContent = 'Saving…';
        try {
          const { status: code, data } = await api.flagExtraction({
            book,
            verdict: v.value,
            key: claim.key,
            corpus: state.corpus,
            slug: state.slug ?? undefined,
          });
          if (code !== 200) {
            status.className = 'st-flag-status st-conv-bad';
            status.textContent = `Failed (${data.error ?? code}).`;
          } else if (v.value === 'good') {
            status.className = 'st-flag-status st-muted';
            status.textContent = data.cleared ? 'Recorded — earlier flag cleared.' : 'Recorded.';
          } else {
            status.className = 'st-flag-status st-conv-warn';
            status.textContent = `Flagged — “${v.text}”`
              + ((data.report_count ?? 1) > 1 ? ` (${data.report_count} reports)` : '');
          }
        } catch (e) {
          status.className = 'st-flag-status st-conv-bad';
          status.textContent = 'Failed to save.';
          log.error(`extraction flag failed: ${String(e)}`, '/workbenches/study/main.ts');
        } finally {
          row.querySelectorAll('button').forEach((x) => { (x as HTMLButtonElement).disabled = false; });
        }
      })();
    });
    row.append(b);
  });

  box.replaceChildren(row, status);
}

function hyperlitAnchorUrl(claim: ClaimRow | null): string | null {
  const base = hyperlitUrl();
  if (!base) return null;
  return claim?.node_id ? `${base}#${encodeURIComponent(claim.node_id)}` : base;
}

/**
 * Navigate the frame, forcing a reload when only the hash changed — anchors
 * (and :target styling) resolve at document load, so a hash-only assignment
 * neither scrolls nor re-marks (the hypercites panes.ts gotcha).
 */
function navigateFrame(frame: HTMLIFrameElement, url: string): void {
  const currentPath = (frame.src || '').split('#')[0];
  if (currentPath === url.split('#')[0] && frame.src !== '') {
    frame.src = 'about:blank';
    requestAnimationFrame(() => {
      frame.src = url;
    });
  } else {
    frame.src = url;
  }
}

async function runPdfSearch(): Promise<void> {
  const hitsBox = byId<HTMLDivElement>('st-pdf-hits');
  const query = byId<HTMLInputElement>('st-pdf-query').value.trim();
  if (query.length < 2 || !state.slug) return;
  hitsBox.replaceChildren(el('p', 'st-empty', 'Searching…'));
  try {
    const { status, data: result } = await api.pdfSearch(state.corpus, state.slug, query);
    if (status !== 200) {
      const why =
        result.error === 'pdftotext_unavailable'
          ? 'pdftotext is not installed on the server.'
          : result.error === 'no_pdf' || result.error === 'no_source_book'
            ? 'This book has no source PDF.'
            : `Search failed (${result.error ?? status}).`;
      hitsBox.replaceChildren(el('p', 'st-empty', why));
      return;
    }
    if (result.hits.length === 0) {
      hitsBox.replaceChildren(el('p', 'st-empty', 'No matches in the PDF text layer.'));
      return;
    }
    hitsBox.replaceChildren(
      ...result.hits.map((hit) => {
        const b = el('button', 'st-hit');
        b.type = 'button';
        b.append(el('span', 'st-hit-page', `p.${hit.page}`), el('span', 'st-hit-snippet', hit.snippet));
        b.addEventListener('click', () => jumpToPage(result.pdf_book_id, hit.page));
        return b;
      }),
    );
    if (result.truncated) hitsBox.append(el('p', 'st-muted', 'More matches truncated…'));
  } catch (e) {
    hitsBox.replaceChildren(el('p', 'st-empty', 'Search failed.'));
    log.error(`pdf search failed: ${String(e)}`, '/workbenches/study/main.ts');
  }
}

/** Hyperlit-view search: hits are nodes of the study copy; click → anchor jump. */
async function runNodeSearch(): Promise<void> {
  const hitsBox = byId<HTMLDivElement>('st-pdf-hits');
  const query = byId<HTMLInputElement>('st-pdf-query').value.trim();
  if (query.length < 2 || !state.slug) return;
  hitsBox.replaceChildren(el('p', 'st-empty', 'Searching…'));
  // In the Source view the box searches what we EXTRACTED, not the article being reviewed.
  const sourceBook = paneView === 'source' ? (selectedClaim()?.source.book_id ?? null) : null;
  try {
    const { status, data: result } = await api.nodeSearch(state.corpus, state.slug, query, sourceBook);
    if (status !== 200) {
      hitsBox.replaceChildren(el('p', 'st-empty', `Search failed (${result.error ?? status}).`));
      return;
    }
    if (result.hits.length === 0) {
      hitsBox.replaceChildren(el('p', 'st-empty',
        sourceBook ? 'Not present in the text we extracted from this source.' : 'No matches in the article.'));
      return;
    }
    hitsBox.replaceChildren(
      ...result.hits.map((hit) => {
        const b = el('button', 'st-hit');
        b.type = 'button';
        b.append(el('span', 'st-hit-page', '¶'), el('span', 'st-hit-snippet', hit.snippet));
        b.addEventListener('click', () => jumpToNode(hit.node_id, sourceBook));
        return b;
      }),
    );
    if (result.truncated) hitsBox.append(el('p', 'st-muted', 'More matches truncated…'));
  } catch (e) {
    hitsBox.replaceChildren(el('p', 'st-empty', 'Search failed.'));
    log.error(`node search failed: ${String(e)}`, '/workbenches/study/main.ts');
  }
}

function jumpToNode(nodeId: string, sourceBook?: string | null): void {
  const base = sourceBook
    ? `/api/maintainer/study/source/${encodeURIComponent(sourceBook)}`
    : hyperlitUrl();
  if (!base) return;
  const url = `${base}#${encodeURIComponent(nodeId)}`;
  const frame = byId<HTMLIFrameElement>('st-pdf-frame');
  frame.setAttribute('data-view-url', url);
  navigateFrame(frame, url);
}

function jumpToPage(bookId: string, page: number): void {
  const frame = byId<HTMLIFrameElement>('st-pdf-frame');
  const url = `/api/maintainer/conversion/original/${encodeURIComponent(bookId)}#page=${page}`;
  frame.setAttribute('data-view-url', url);
  navigateFrame(frame, url);
}

/** Pre-fill the search box with the citation's most identifying words. */
function prefillPdfSearch(claim: ClaimRow): void {
  const query = byId<HTMLInputElement>('st-pdf-query');
  const meta = claim.llm_metadata as { surname?: string; title?: string } | null;
  const surname = typeof meta?.surname === 'string' ? meta.surname : '';
  const title = typeof meta?.title === 'string' ? meta.title : '';
  const guess = surname || title.split(/\s+/).slice(0, 4).join(' ');
  if (guess && !query.value) query.value = guess;
}

// -------------------------------------------------------------------- wiring

// The filter trio survives a refresh: resetting to "flagged only" on every
// reload made the operator re-set their view each time. Saved only on a USER
// click — restoreSelectionFromUrl() may clear filters to reveal the restored
// claim, and that view necessity must not clobber the saved preference.
const FILTERS_STORAGE_KEY = 'studyWorkbenchFilters';

interface SavedFilters {
  flagged?: boolean;
  unadjudicated?: boolean;
  needsEvidence?: boolean;
  urlUnchecked?: boolean;
}

function saveFilters(): void {
  try {
    localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify({
      flagged: state.filterFlagged,
      unadjudicated: state.filterUnadjudicated,
      needsEvidence: state.filterNeedsEvidence,
      urlUnchecked: state.filterUrlUnchecked,
    }));
  } catch {
    // private mode / quota — the session still works, just without persistence
  }
}

function loadSavedFilters(): void {
  let saved: SavedFilters | null = null;
  try {
    const raw = localStorage.getItem(FILTERS_STORAGE_KEY);
    saved = raw ? (JSON.parse(raw) as SavedFilters) : null;
  } catch {
    return;
  }
  if (!saved) return;
  state.filterFlagged = !!saved.flagged;
  state.filterUnadjudicated = !!saved.unadjudicated;
  state.filterNeedsEvidence = !!saved.needsEvidence;
  state.filterUrlUnchecked = !!saved.urlUnchecked;
  byId<HTMLInputElement>('st-filter-flagged').checked = state.filterFlagged;
  byId<HTMLInputElement>('st-filter-unadjudicated').checked = state.filterUnadjudicated;
  byId<HTMLInputElement>('st-filter-needs-evidence').checked = state.filterNeedsEvidence;
  byId<HTMLInputElement>('st-filter-url-unchecked').checked = state.filterUrlUnchecked;
}

function wireFilters(): void {
  byId<HTMLInputElement>('st-filter-flagged').addEventListener('change', (e) => {
    state.filterFlagged = (e.target as HTMLInputElement).checked;
    saveFilters();
    renderList();
  });
  byId<HTMLInputElement>('st-filter-unadjudicated').addEventListener('change', (e) => {
    state.filterUnadjudicated = (e.target as HTMLInputElement).checked;
    saveFilters();
    renderList();
  });
  byId<HTMLInputElement>('st-filter-needs-evidence').addEventListener('change', (e) => {
    state.filterNeedsEvidence = (e.target as HTMLInputElement).checked;
    saveFilters();
    renderList();
  });
  byId<HTMLInputElement>('st-filter-url-unchecked').addEventListener('change', (e) => {
    state.filterUrlUnchecked = (e.target as HTMLInputElement).checked;
    saveFilters();
    renderList();
  });
  const helpToggle = byId<HTMLButtonElement>('st-help-toggle');
  helpToggle.addEventListener('click', () => {
    const help = byId('st-help');
    help.hidden = !help.hidden;
    helpToggle.setAttribute('aria-expanded', String(!help.hidden));
  });
}

wireFilters();
loadSavedFilters();
void loadBooks();
if (state.slug) void loadBook();
