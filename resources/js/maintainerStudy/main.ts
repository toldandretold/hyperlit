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
import {
  api,
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
  { value: 'grey_literature', text: 'grey literature — legitimately unindexed',
    desc: "A real source that no index carries (internal reports, Hansard, legislation). Nobody's failure." },
  { value: 'other', text: 'other (note)',
    desc: 'None of the above — explain in the note.' },
];

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
      `${book.arm} · ${book.run_status === 'completed' ? `${book.counts.flagged}/${book.counts.total} flagged · ${book.counts.adjudicated} done` : book.run_status}`,
    ),
  );
  row.addEventListener('click', () => {
    state.slug = book.slug;
    state.selectedKey = null;
    history.replaceState(null, '', `/maintainer/study/${encodeURIComponent(book.slug)}`);
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
  if (claim.adjudication) head.append(el('span', 'st-badge st-done', '✓ ' + claim.adjudication.label));
  row.append(head, el('span', 'st-claim-text', (claim.truth_claim ?? '').slice(0, 140)));

  row.addEventListener('click', () => {
    state.selectedKey = claim.key;
    renderList();
    renderDetail(claim);
    if (paneView === 'hyperlit') jumpToClaimInHyperlit(claim);
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
    if (claim.source.url || claim.source.doi) {
      const p = el('p');
      const a = el('a', undefined, claim.source.url ?? `doi:${claim.source.doi}`);
      a.setAttribute('href', claim.source.url ?? `https://doi.org/${claim.source.doi}`);
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener');
      p.append(a);
      srcSec.append(p);
    }
  } else {
    srcSec.append(el('p', 'st-muted', 'No source found by the resolver.'));
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
  frag.append(convSec);

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

function section(title: string, body: string): HTMLElement {
  const sec = el('section', 'st-section');
  sec.append(el('h3', undefined, title), el('p', undefined, body));
  return sec;
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

  const labelRow = el('div', 'st-btnrow');
  const labelButtons = LABELS.map((l) => {
    const b = el('button', 'st-choice', l.text);
    b.type = 'button';
    b.title = l.desc; // hover tooltip; full list under the ? button
    b.addEventListener('click', () => {
      chosenLabel = l.value;
      labelButtons.forEach((x) => x.classList.toggle('st-choice-on', x === b));
      causeRow.classList.remove('st-disabled');
      saveBtn.disabled = false;
    });
    return b;
  });
  labelRow.append(...labelButtons);

  const causeRow = el('div', 'st-btnrow st-disabled');
  const causeButtons = CAUSES.map((c) => {
    const b = el('button', 'st-choice st-choice-cause', c.text);
    b.type = 'button';
    b.title = c.desc;
    b.addEventListener('click', () => {
      chosenCause = chosenCause === c.value ? null : c.value;
      causeButtons.forEach((x) => x.classList.toggle('st-choice-on', x.textContent === c.text && chosenCause === c.value));
    });
    return b;
  });
  causeRow.append(...causeButtons);

  const foundUrl = el('input', 'st-note st-found-url') as HTMLInputElement;
  foundUrl.type = 'url';
  foundUrl.placeholder =
    'URL where YOU found the source (optional) — each one becomes a resolver test case';

  const note = el('textarea', 'st-note') as HTMLTextAreaElement;
  note.placeholder = 'Optional note — your evidence/reasoning; saved with the verdict, lands in dataset.csv';
  note.rows = 2;

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
      note: note.value.trim() || null,
      found_url: foundUrl.value.trim() || null,
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
    foundUrl,
    note,
    saveBtn,
  );
  return form;
}

function currentAdjudication(claim: ClaimRow, adj: Adjudication): HTMLElement {
  const wrap = el('div', 'st-current');
  const line = `${adj.label}${adj.cause ? ` · ${adj.cause.replace(/_/g, ' ')}` : ''} — ${adj.adjudicated_by}`;
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
    byId<HTMLSpanElement>('st-apply-summary').textContent =
      `Applied ${data.applied} label(s) to ground truth — re-run citation:study:report ${state.corpus}.`;
  };
}

// -------------------------------------------------------------- source pane
// Two views in one pane: the ORIGINAL PDF (browser viewer + server-side text
// search) and HYPERLIT (the study copy's stored nodes rendered by the
// admin-gated /render endpoint — the real reader can't frame the study copy:
// it is deliberately RLS-private, and several source books are too). The
// Hyperlit view is where "jump to this citation" is exact: claims carry the
// study copy's node_ids, which are the render's anchors.

let paneView: 'pdf' | 'hyperlit' = 'pdf';
let pdfAvailable = false;

function pdfUrl(): string | null {
  const bookId = state.payload?.source_book_id;
  return bookId ? `/api/maintainer/conversion/original/${encodeURIComponent(bookId)}` : null;
}

function hyperlitUrl(): string | null {
  if (!state.slug || state.payload?.run_status !== 'completed') return null;
  return `/api/maintainer/study/render/${encodeURIComponent(state.slug)}?corpus=${encodeURIComponent(state.corpus)}`;
}

function setupPdfPane(): void {
  const pane = byId<HTMLElement>('st-pdf-pane');
  const original = pdfUrl();
  const hyperlit = hyperlitUrl();
  if (!original && !hyperlit) {
    pane.hidden = true;
    return;
  }
  pane.hidden = false;
  pdfAvailable = false;

  if (original) {
    // HEAD-probe: a source book without original.pdf (web imports) keeps the
    // pane but disables the Original view instead of hiding everything.
    void fetch(original, { method: 'HEAD', credentials: 'include' }).then((res) => {
      pdfAvailable = res.ok;
      if (!res.ok && paneView === 'pdf') setPaneView('hyperlit');
      else setPaneView(paneView);
    });
  } else {
    setPaneView('hyperlit');
  }

  byId<HTMLButtonElement>('st-view-pdf').onclick = () => setPaneView('pdf');
  byId<HTMLButtonElement>('st-view-hyperlit').onclick = () => setPaneView('hyperlit');
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

function setPaneView(view: 'pdf' | 'hyperlit'): void {
  if (view === 'pdf' && !pdfAvailable) view = 'hyperlit';
  if (view === 'hyperlit' && !hyperlitUrl()) view = 'pdf';
  paneView = view;

  const pdfBtn = byId<HTMLButtonElement>('st-view-pdf');
  const hlBtn = byId<HTMLButtonElement>('st-view-hyperlit');
  pdfBtn.setAttribute('aria-selected', String(view === 'pdf'));
  hlBtn.setAttribute('aria-selected', String(view === 'hyperlit'));
  pdfBtn.disabled = !pdfAvailable;
  hlBtn.disabled = !hyperlitUrl();

  // One search strip, two backends: pdf-search (pdftotext, page hits) in PDF
  // view, node-search (the study copy's plainText, node hits) in Hyperlit.
  byId<HTMLInputElement>('st-pdf-query').placeholder =
    view === 'pdf' ? 'Search the PDF…' : 'Search the article…';
  byId<HTMLDivElement>('st-pdf-hits').replaceChildren();

  const frame = byId<HTMLIFrameElement>('st-pdf-frame');
  const target = view === 'pdf' ? pdfUrl() : hyperlitAnchorUrl(selectedClaim());
  if (target && frame.getAttribute('data-view-url') !== target) {
    frame.setAttribute('data-view-url', target);
    navigateFrame(frame, target);
  }
}

function selectedClaim(): ClaimRow | null {
  return state.payload?.claims.find((c) => c.key === state.selectedKey) ?? null;
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
  try {
    const { status, data: result } = await api.nodeSearch(state.corpus, state.slug, query);
    if (status !== 200) {
      hitsBox.replaceChildren(el('p', 'st-empty', `Search failed (${result.error ?? status}).`));
      return;
    }
    if (result.hits.length === 0) {
      hitsBox.replaceChildren(el('p', 'st-empty', 'No matches in the article.'));
      return;
    }
    hitsBox.replaceChildren(
      ...result.hits.map((hit) => {
        const b = el('button', 'st-hit');
        b.type = 'button';
        b.append(el('span', 'st-hit-page', '¶'), el('span', 'st-hit-snippet', hit.snippet));
        b.addEventListener('click', () => jumpToNode(hit.node_id));
        return b;
      }),
    );
    if (result.truncated) hitsBox.append(el('p', 'st-muted', 'More matches truncated…'));
  } catch (e) {
    hitsBox.replaceChildren(el('p', 'st-empty', 'Search failed.'));
    log.error(`node search failed: ${String(e)}`, '/maintainerStudy/main.ts');
  }
}

function jumpToNode(nodeId: string): void {
  const base = hyperlitUrl();
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
