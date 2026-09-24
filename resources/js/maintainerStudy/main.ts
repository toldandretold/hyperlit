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

import { confirmDialog } from '../components/dialog/dialog';
import { log } from '../utilities/logger';
import { drainResponse } from '../utilities/drainResponse';
import {
  api,
  EVIDENCE_MAX_CHARS,
  type Adjudication,
  type BookPayload,
  type BookSummary,
  type ClaimRow,
} from './api';

const FLAGGED = new Set(['rejected', 'unlikely', 'source_not_found', 'insufficient']);

// Axis 1 — your verdict on the CITATION ITSELF. Applied, it becomes the
// entry's label in ground_truth.json: the baseline the AI is scored against.
const LABELS: Array<{ value: string; text: string; desc: string }> = [
  { value: 'verified_intact', text: 'verified intact',
    desc: 'The citation is genuine and supports the claim — you checked. If the AI flagged it, that becomes a false positive against the AI.' },
  { value: 'fabricated_reference', text: 'fabricated reference',
    desc: 'The cited work does not exist.' },
  { value: 'source_swap', text: 'source swap',
    desc: 'The work exists, but the claim actually comes from a different work.' },
  { value: 'claim_distortion', text: 'claim distortion',
    desc: 'The source exists but does not say what the author claims.' },
  { value: 'suspect', text: 'suspect',
    desc: "Something is off but you can't pin it down. NOT scored — excluded from the confusion matrix." },
  { value: 'unverifiable', text: 'unverifiable',
    desc: 'Cannot be checked either way (grey literature, "copy on file with author"). NOT scored.' },
  { value: 'not_a_citation', text: 'not a citation',
    desc: "The reviewed pairing doesn't exist in the author's text — a phantom/mislinked anchor or a non-citation footnote. Nothing to verify, so nothing to score. NOT scored; pairs with the citation-mislink cause." },
];

// Axis 2 — your verdict on the AI'S FLAG: whose failure was it? Feeds system
// improvement (dataset.csv human_cause), never the baseline.
const CAUSES: Array<{ value: string; text: string; desc: string }> = [
  { value: 'correct_flag', text: 'correct flag — citation genuinely bad',
    desc: 'The AI was right to flag this citation.' },
  { value: 'resolver_gap', text: 'resolver gap — source exists, we missed it',
    desc: 'The source is real and findable; our resolver failed to find it. Fixable on our side.' },
  { value: 'conversion_mangled', text: 'conversion mangled — our OCR',
    desc: 'Our PDF conversion corrupted the citation text before the AI ever saw it. Check the Conversion check block.' },
  { value: 'claim_scoping', text: 'claim scoping — wrong sentence/slice attributed',
    desc: 'Our extractor attributed text this citation was never meant to support: a slice of a grouped citation (A; B; C), or an adjacent UNCITED sentence grabbed instead of the cited one. The citation is fine; the verifier honestly reported the mismatch. Usually pairs with verified intact.' },
  { value: 'citation_mislink', text: 'citation mislink — our linker minted/misdirected the anchor',
    desc: "The author never made this claim-source pairing: our in-text linker turned a bare year (or year range) into a citation, or pointed a real citation at the wrong entry. The AI honestly reviewed a pairing that doesn't exist. Usually pairs with verified intact." },
  { value: 'evidence_truncated', text: 'evidence truncated — our snapshot clipped it',
    desc: 'The source was correctly resolved, but the supporting text lies beyond what we stored (e.g. the web-fetch character cap). You found the evidence in the full source; the AI never saw it. Usually pairs with verified intact.' },
  { value: 'grey_literature', text: 'grey literature — legitimately unindexed',
    desc: "A real source that no index carries (internal reports, Hansard, legislation). Nobody's failure." },
  { value: 'citation_typo', text: 'citation typo — minor error defeated matching',
    desc: 'The citation is real and supports the claim, but a small error (missing/wrong word in the title, off-by-one year or page) likely broke exact matching. Pair with verified intact — the typo is not an integrity issue; put the exact discrepancy in the note.' },
  { value: 'access_blocked', text: 'access blocked — paywall / bot wall',
    desc: 'The cited URL exists but refused our fetcher (401/403/429, or a subscribe-wall). NOT a dead link — verify the article in your browser; if it checks out, the label is about the content, this cause records why our system could not see it.' },
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
 * WHAT the citation actually supports — the third ground-truth axis.
 *
 * The support scale has no fixed DENOMINATOR, so a verdict alone is ambiguous: "unlikely" means
 * both "supports none of this" and "supports exactly the part it was cited for, and nothing else".
 * Recording which makes the ground truth independent of the verify prompt a run used, so the SAME
 * labels score both variants (services.citation_review.verify_scope). A fragment_only claim SHOULD
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
    desc: 'The source supports no part of the claim.' },
  { value: 'undetermined', text: "can't tell without the source",
    desc: 'Blocked, dead or not retrieved — you could not read enough to judge scope.' },
];

/** A workbench URL that SURVIVES a refresh — the corpus must ride in the query string. */
function studyUrl(slug: string | null, corpus?: string): string {
  const c = corpus ?? state.corpus;
  const base = slug ? `/maintainer/study/${encodeURIComponent(slug)}` : '/maintainer/study';
  return `${base}?corpus=${encodeURIComponent(c)}`;
}

interface State {
  corpus: string;
  slug: string | null;
  payload: BookPayload | null;
  selectedKey: string | null;
  filterFlagged: boolean;
  filterUnadjudicated: boolean;
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
    log.error(`study books load failed: ${String(e)}`, '/maintainerStudy/main.ts');
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

function visibleClaims(): ClaimRow[] {
  const payload = state.payload;
  if (!payload) return [];
  return payload.claims.filter((c) => {
    if (state.filterFlagged && !FLAGGED.has(c.verdict)) return false;
    if (state.filterUnadjudicated && c.adjudication) return false;
    return true;
  });
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
    log.error(`study claims load failed: ${String(e)}`, '/maintainerStudy/main.ts');
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
  }
}

function renderList(): void {
  const list = byId<HTMLDivElement>('st-list');
  const claims = visibleClaims();
  if (claims.length === 0) {
    list.replaceChildren(el('p', 'st-empty', 'No claims match the filter.'));
    return;
  }
  list.replaceChildren(...claims.map((c) => claimRow(c)));
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
  if (claim.adjudication) head.append(el('span', 'st-badge st-done', '✓ ' + claim.adjudication.label));
  row.append(head, el('span', 'st-claim-text', (claim.truth_claim ?? '').slice(0, 140)));

  row.addEventListener('click', () => {
    state.selectedKey = claim.key;
    renderList();
    renderDetail(claim);
    // The pane follows the selection: Hyperlit lands on this claim's node, Source swaps to THIS
    // claim's extracted text (falling back when it resolved none). Tabs refresh either way —
    // whether Source is reachable is a fact about the claim you just picked.
    refreshPaneTabs();
    renderExtractionFlag(claim);
    if (paneView === 'source') setPaneView('source');
    else if (paneView === 'hyperlit') jumpToClaimInHyperlit(claim);
  });
  return row;
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

  // Claims.
  if (claim.truth_claim) frag.append(section('Truth claim', claim.truth_claim));
  if (claim.contextualised_claim && claim.contextualised_claim !== claim.truth_claim) {
    frag.append(section('Contextualised', claim.contextualised_claim));
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

  // Resolved source (or not).
  const srcSec = el('section', 'st-section');
  srcSec.append(el('h3', undefined, 'Resolved source'));
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
  frag.append(srcSec);

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
        text: 'Save verdict: unverifiable · dead link',
        label: 'unverifiable',
        cause: 'dead_link',
        note: `Check link: ${deadSummary} — ${url}`,
      }));
    } else if (data.ok && data.reachable && data.category === 'blocked') {
      // The three outcomes of the browser check, each one click. Verification
      // is TWO-LEVEL and a paywall splits them: the work's EXISTENCE (title/
      // author visible behind most paywalls) vs claim SUPPORT (needs the
      // body). reference_exists carries the first; the label carries the
      // second — an unverifiable row with reference_exists=true still counts
      // as a fabrication-negative in analysis.
      wrap.append(
        quickSaveButton(claim, wrap, {
          text: 'Read the body, supports the claim → verified intact',
          label: 'verified_intact',
          cause: 'access_blocked',
          referenceExists: true,
          note: `Check link: HTTP ${data.status} blocked our fetcher; read in browser, claim supported — ${url}`,
        }),
        quickSaveButton(claim, wrap, {
          text: "Title/author match through the paywall, body unreadable → unverifiable (work exists)",
          label: 'unverifiable',
          cause: 'access_blocked',
          referenceExists: true,
          note: `Check link: HTTP ${data.status} blocked our fetcher; work confirmed real through paywall, claim support unverifiable — ${url}`,
        }),
        quickSaveButton(claim, wrap, {
          text: "Couldn't even confirm the work → unverifiable",
          label: 'unverifiable',
          cause: 'access_blocked',
          referenceExists: false,
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
  opts: { text: string; label: string; cause: string; note: string; referenceExists?: boolean },
): HTMLButtonElement {
  const save = el('button', 'st-save', opts.text);
  save.type = 'button';
  save.title = 'One-click adjudication — Undo on the saved verdict if you change your mind.';
  save.addEventListener('click', async () => {
    if (!state.slug) return;
    save.disabled = true;
    const { status: st, data: res } = await api.adjudicate(state.corpus, state.slug, {
      key: claim.key,
      label: opts.label,
      cause: opts.cause,
      note: opts.note.slice(0, 1900),
      found_url: null,
      reference_exists: opts.referenceExists ?? null,
      referenceId: claim.referenceId,
      run_id: state.payload?.run_id ?? null,
    });
    save.disabled = false;
    if (st !== 200 || !res.ok || !res.adjudication) {
      flash(wrap, res.error ?? `Save failed (${st})`);
      return;
    }
    claim.adjudication = res.adjudication;
    bumpAdjudicatedCount(1);
    renderList();
    renderApplyBar();
    renderDetail(claim); // re-render: shows the ✓ verdict + Undo
  });
  return save;
}

/**
 * File the SOURCE book into the bad-conversion queue (/maintainer/conversion)
 * with a reason pre-filled from this claim — the workbench keeps surfacing
 * conversion-caused defects (OCR-garbled footnotes, phantom year-range
 * citation links) that deserve a reconvert-queue item, not just a note.
 */
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
 * identically: the first-verdict form, and the saved verdict (where it is the
 * only way to backfill, since the other mutation there is a destructive Undo).
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
  textarea.placeholder =
    'Quotes from the source that back this verdict — one per paragraph. Select text in the pane and press "use selection", or paste.';
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

function adjudicationForm(claim: ClaimRow): HTMLElement {
  const form = el('section', 'st-section st-adjudicate');
  const heading = el('h3', undefined, 'Your verdict ');
  const helpBtn = el('button', 'st-verdict-help-toggle', '?');
  helpBtn.type = 'button';
  helpBtn.setAttribute('aria-expanded', 'false');
  heading.append(helpBtn);
  form.append(heading);

  const help = el('div', 'st-verdict-help');
  help.hidden = true;
  const helpIntro = el('p', undefined,
    'Two separate judgements. LABEL = is the CITATION good? — it becomes the ground-truth '
    + 'baseline the AI is scored against on Apply. CAUSE = was the AI\'s FLAG right, and if '
    + 'not, whose failure was it? — it feeds system improvement, never the baseline. The note '
    + 'saves with both to the corpus adjudications file and lands in dataset.csv as human_note.');
  help.append(helpIntro);
  const dl = el('dl');
  for (const l of LABELS) {
    dl.append(el('dt', undefined, l.text), el('dd', undefined, l.desc));
  }
  for (const c of CAUSES) {
    dl.append(el('dt', undefined, c.text.split(' — ')[0]), el('dd', undefined, c.desc));
  }
  help.append(dl);
  helpBtn.addEventListener('click', () => {
    help.hidden = !help.hidden;
    helpBtn.setAttribute('aria-expanded', String(!help.hidden));
  });
  form.append(help);

  if (claim.adjudication) {
    form.append(currentAdjudication(claim, claim.adjudication));
    return form;
  }

  let chosenLabel: string | null = null;
  let chosenCause: string | null = null;
  let chosenScope: string | null = null;

  const labelRow = el('div', 'st-btnrow');
  const labelButtons = LABELS.map((l) => {
    const b = el('button', 'st-choice', l.text);
    b.type = 'button';
    b.title = l.desc; // hover tooltip; full list under the ? button
    b.addEventListener('click', () => {
      chosenLabel = l.value;
      labelButtons.forEach((x) => x.classList.toggle('st-choice-on', x === b));
      causeRow.classList.remove('st-disabled');
      scopeRow.classList.remove('st-disabled');
      saveBtn.disabled = false;
    });
    return b;
  });
  labelRow.append(...labelButtons);

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
      causeButtons.forEach((x) => x.classList.toggle('st-choice-on', x.textContent === c.text && chosenCause === c.value));
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

  // Third axis: WHAT the citation supports. Enabled with the cause row, optional like the cause —
  // but it is the axis that lets one set of labels score BOTH verify-prompt denominators, so it is
  // worth filling on every scope-sensitive claim.
  const scopeRow = el('div', 'st-btnrow st-disabled');
  const scopeButtons = SUPPORTED_SCOPES.map((sc) => {
    const b = el('button', 'st-choice st-choice-scope', sc.text);
    b.type = 'button';
    b.title = sc.desc;
    b.addEventListener('click', () => {
      chosenScope = chosenScope === sc.value ? null : sc.value;
      scopeButtons.forEach((x) => x.classList.toggle('st-choice-on', x.textContent === sc.text && chosenScope === sc.value));
    });
    return b;
  });
  scopeRow.append(...scopeButtons);

  // Reference-level fact, orthogonal to the (claim-level) label: a paywall
  // lets you confirm the WORK is real without reading the body.
  const refExistsWrap = el('label', 'st-refexists');
  const refExists = el('input') as HTMLInputElement;
  refExists.type = 'checkbox';
  refExistsWrap.append(refExists, ' work exists — title/author verified (even if claim support is not)');

  const foundUrl = el('input', 'st-note st-found-url') as HTMLInputElement;
  foundUrl.type = 'url';
  foundUrl.placeholder =
    'URL where YOU found the source (optional) — each one becomes a resolver test case';

  const note = el('textarea', 'st-note') as HTMLTextAreaElement;
  note.placeholder = 'Optional note — your reasoning; saved with the verdict, lands in dataset.csv';
  note.rows = 2;

  const evidence = evidenceFields(null);

  const saveBtn = el('button', 'st-save', 'Save verdict') as HTMLButtonElement;
  saveBtn.type = 'button';
  saveBtn.disabled = true;
  saveBtn.addEventListener('click', async () => {
    if (!chosenLabel || !state.slug) return;
    form.classList.add('st-busy');
    const { status, data } = await api.adjudicate(state.corpus, state.slug, {
      key: claim.key,
      label: chosenLabel,
      cause: chosenCause,
      supported_scope: chosenScope,
      note: note.value.trim() || null,
      found_url: foundUrl.value.trim() || null,
      reference_exists: refExists.checked ? true : null,
      evidence: evidence.value(),
      evidence_locator: evidence.locatorValue(),
      referenceId: claim.referenceId,
      run_id: state.payload?.run_id ?? null,
    });
    form.classList.remove('st-busy');
    if (status !== 200 || !data.ok || !data.adjudication) {
      flash(form, data.error ?? `Save failed (${status})`);
      log.error(`adjudicate failed: ${data.error ?? status}`, '/maintainerStudy/main.ts');
      return;
    }
    claim.adjudication = data.adjudication;
    bumpAdjudicatedCount(1);
    renderList();
    renderApplyBar();
    form.replaceChildren(el('h3', undefined, 'Your verdict'), currentAdjudication(claim, data.adjudication));
  });

  form.append(
    el('p', 'st-axis-label', 'Label — is the CITATION good? (becomes ground truth on Apply):'),
    labelRow,
    el('p', 'st-axis-label', "Cause — was the AI's flag right? If not, whose failure? (optional):"),
    causeRow,
    el('p', 'st-axis-label', 'Scope — WHAT does the citation support? (scores both verify prompts):'),
    scopeRow,
    refExistsWrap,
    foundUrl,
    note,
    evidence.wrap,
    saveBtn,
  );
  return form;
}

function currentAdjudication(claim: ClaimRow, adj: Adjudication): HTMLElement {
  const wrap = el('div', 'st-current');
  const refBit = adj.reference_exists === true ? ' · work exists ✓' : adj.reference_exists === false ? ' · work unconfirmed ✗' : '';
  // Surface the scope axis on the saved verdict — an invisible field does not get filled in.
  const scopeBit = adj.supported_scope
    ? ' · scope: ' + (SUPPORTED_SCOPES.find((s) => s.value === adj.supported_scope)?.text ?? adj.supported_scope)
    : '';
  // A verdict recorded against an OLDER run than the book's current one —
  // fine for citation-truth verdicts, but a stale citation_mislink describes
  // anchors that a reimport likely fixed.
  const stale = adj.run_id && state.payload?.run_id && adj.run_id !== state.payload.run_id;
  const staleBit = stale ? (adj.cause === 'citation_mislink' ? ' · ⚠ OLDER RUN — re-check' : ' · (older run)') : '';
  const line = `${adj.label}${adj.cause ? ` · ${adj.cause.replace(/_/g, ' ')}` : ''}${refBit}${scopeBit}${staleBit} — ${adj.adjudicated_by}`;
  wrap.append(el('p', 'st-badge st-done', `✓ ${line}`));
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
  const undo = el('button', 'st-undo', 'Undo');
  undo.type = 'button';
  undo.addEventListener('click', async () => {
    if (!state.slug) return;
    const { status, data } = await api.retract(state.corpus, state.slug, claim.key);
    if (status !== 200 || !data.ok) {
      flash(wrap, data.error ?? `Undo failed (${status})`);
      return;
    }
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
 * missing, editable either way — WITHOUT going through Undo, which deletes the
 * record. This is the only path that can backfill the verdicts recorded before
 * the field existed, and there are ~50 of those.
 */
function evidenceBlock(claim: ClaimRow, adj: Adjudication, host: HTMLElement): HTMLElement {
  const block = el('div', 'st-evidence-block');

  if (adj.evidence) {
    // pre-wrap in CSS, so paragraphs survive without innerHTML (house rule).
    block.append(el('blockquote', 'st-evidence-quote', adj.evidence));
    const meta = [adj.evidence_locator, adj.evidenced_by ? `evidenced by ${adj.evidenced_by}` : null]
      .filter(Boolean)
      .join(' · ');
    if (meta) block.append(el('p', 'st-muted', meta));
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
      log.error(`evidence save failed: ${data.error ?? status}`, '/maintainerStudy/main.ts');
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
          log.error(`extraction flag failed: ${String(e)}`, '/maintainerStudy/main.ts');
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
    log.error(`pdf search failed: ${String(e)}`, '/maintainerStudy/main.ts');
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
    log.error(`node search failed: ${String(e)}`, '/maintainerStudy/main.ts');
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

function wireFilters(): void {
  byId<HTMLInputElement>('st-filter-flagged').addEventListener('change', (e) => {
    state.filterFlagged = (e.target as HTMLInputElement).checked;
    renderList();
  });
  byId<HTMLInputElement>('st-filter-unadjudicated').addEventListener('change', (e) => {
    state.filterUnadjudicated = (e.target as HTMLInputElement).checked;
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
void loadBooks();
if (state.slug) void loadBook();
