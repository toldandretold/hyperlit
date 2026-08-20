/**
 * /maintainer/hypercites — the citation-graph review console (standalone,
 * non-SPA, admin-only; see Maintainer\HyperciteConsoleController).
 *
 * One entry, two pages, decided by `window.__hyperciteConsole.slug`: the INDEX
 * picks a journal, the DETAIL page reviews one journal's hypercite candidates —
 * citing article framed left, cited article framed right, evidence + verdict in
 * the list column. Approve mints the hypercite; the right pane then reloads at
 * the new anchor so you SEE what you just created.
 */

import { log } from '../utilities/logger';
import { api, scopeBase, type Candidate, type MostCitedRow, type RunStatus } from './api';
import { ReaderPane, type MarkSpec } from './panes';

interface ConsoleBoot {
  slug: string | null;
  shelfId: string | null;
  scopeLabel: string | null;
}

const bootOf = (): ConsoleBoot => {
  const raw = (window as unknown as { __hyperciteConsole?: Partial<ConsoleBoot> }).__hyperciteConsole ?? {};
  return { slug: raw.slug ?? null, shelfId: raw.shelfId ?? null, scopeLabel: raw.scopeLabel ?? null };
};

const el = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;

/* ────────────────────────────── Index ────────────────────────────── */

function candidateCountsLabel(c: Record<string, number>, fallback: string): string {
  const parts: string[] = [];
  for (const key of ['matched', 'applied', 'pending', 'rejected'] as const) {
    if (c[key]) parts.push(`${c[key]} ${key}`);
  }
  return parts.length ? parts.join(' · ') : fallback;
}

function scopeIndexRow(href: string, nameText: string, countsText: string): HTMLAnchorElement {
  const row = document.createElement('a');
  row.className = 'hx-journal-row';
  row.href = href;
  row.setAttribute('role', 'listitem');

  const name = document.createElement('span');
  name.className = 'hx-jname';
  name.textContent = nameText;
  const counts = document.createElement('span');
  counts.className = 'hx-jcounts';
  counts.textContent = countsText;

  row.append(name, counts);
  return row;
}

async function initIndex(): Promise<void> {
  const journalsList = el<HTMLDivElement>('hx-journals-list');
  const journalsEmpty = el<HTMLParagraphElement>('hx-journals-empty');
  const shelvesList = el<HTMLDivElement>('hx-shelves-list');
  const shelvesEmpty = el<HTMLParagraphElement>('hx-shelves-empty');
  if (!journalsList) return;

  try {
    const { journals, shelves } = await api.journals();
    if (!journals.length && journalsEmpty) journalsEmpty.hidden = false;
    if (!shelves.length && shelvesEmpty) shelvesEmpty.hidden = false;

    for (const j of journals) {
      journalsList.appendChild(scopeIndexRow(
        `/maintainer/hypercites/${encodeURIComponent(j.slug)}`,
        j.display_name,
        candidateCountsLabel(j.candidates || {}, 'no candidates yet'),
      ));
    }
    if (shelvesList) {
      for (const s of shelves) {
        shelvesList.appendChild(scopeIndexRow(
          `/maintainer/hypercites/shelf/${encodeURIComponent(s.shelf_id)}`,
          `${s.name} — ${s.creator}`,
          `${s.item_count} books · ${candidateCountsLabel(s.candidates || {}, 'no candidates yet')}`,
        ));
      }
    }
  } catch (err) {
    log.error('hypercites: index load failed', 'maintainer', err);
    if (journalsEmpty) {
      journalsEmpty.hidden = false;
      journalsEmpty.textContent = 'Failed to load — are you logged in as an admin?';
    }
  }
}

/* ────────────────────────────── Detail ────────────────────────────── */

interface DetailState {
  base: string;
  candidates: Candidate[];
  applied: Candidate[];   // the permanent per-scope record, independent of filters
  selected: Candidate | null;
  pollTimer: number | null;
  pollingRunId: string | null;
}

function initDetail(boot: ConsoleBoot): void {
  const state: DetailState = {
    base: scopeBase(boot.slug, boot.shelfId),
    candidates: [],
    applied: [],
    selected: null,
    pollTimer: null,
    pollingRunId: null,
  };
  const titleEl = el<HTMLHeadingElement>('hx-title');
  if (titleEl && boot.scopeLabel) titleEl.textContent = boot.scopeLabel;
  const citingPane = new ReaderPane('hx-citing', 'hx-citing-placeholder', 'hx-citing-label');
  const citedPane = new ReaderPane('hx-cited', 'hx-cited-placeholder', 'hx-cited-label');

  const runStatusEl = el<HTMLSpanElement>('hx-run-status');
  const setRunStatus = (t: string) => { if (runStatusEl) runStatusEl.textContent = t; };

  /* ── Candidate list ── */

  const filters = (): Record<string, string> => {
    const out: Record<string, string> = {};
    const status = el<HTMLSelectElement>('hx-filter-status')?.value ?? '';
    const method = el<HTMLSelectElement>('hx-filter-method')?.value ?? '';
    if (status) out.status = status;
    if (method) out.match_method = method;
    if (el<HTMLInputElement>('hx-filter-internal')?.checked) out.internal = '1';
    return out;
  };

  const statusBadge = (c: Candidate): string => {
    if (c.status === 'applied') return 'applied';
    if (c.status === 'rejected') return 'rejected';
    if (c.status === 'failed') return c.error === 'content_changed_since_apply' ? 'changed' : 'failed';
    if (c.status === 'no_match') return 'not found';
    return c.has_quote ? '' : 'no quote';
  };

  async function loadCandidates(): Promise<void> {
    const list = el<HTMLDivElement>('hx-candidates-list');
    const empty = el<HTMLParagraphElement>('hx-candidates-empty');
    const count = el<HTMLSpanElement>('hx-count');
    if (!list) return;

    try {
      // Two fetches: the working list under the current filter, and the
      // PERMANENT record of applied hypercites for this scope — the whole
      // point of approving is that the result outlives the review session,
      // so it must survive a refresh regardless of what the filter shows.
      const [payload, appliedPayload] = await Promise.all([
        api.candidates(state.base, filters()),
        api.candidates(state.base, { status: 'applied' }),
      ]);
      state.candidates = payload.candidates;
      state.applied = appliedPayload.candidates;

      const title = el<HTMLHeadingElement>('hx-title');
      if (title) title.textContent = payload.scope.display_name;
      const meta = el<HTMLSpanElement>('hx-journal-meta');
      if (meta) meta.textContent = payload.scope.publisher ?? '';

      const total = Object.values(payload.status_counts).reduce((a, b) => a + b, 0);
      if (count) {
        count.textContent = `${payload.candidates.length} shown · ${total} total`
          + (payload.status_counts.applied ? ` · ${payload.status_counts.applied} applied` : '');
      }

      if (empty) empty.hidden = payload.candidates.length > 0 || total > 0;

      renderCandidateList();

      // A refreshed page re-attaches to an in-flight detect: the run lives on
      // the queue worker, so without this the status line sits empty and the
      // run looks dead until the operator presses detect again.
      if (payload.active_run && state.pollingRunId !== payload.active_run.id) {
        setRunStatus(payload.active_run.step_detail ?? payload.active_run.status);
        poll(payload.active_run.id);
      }
    } catch (err) {
      log.error('hypercites: candidates load failed', 'maintainer', err);
      if (count) count.textContent = 'failed to load';
    }
  }

  /**
   * Re-render the list from state WITHOUT refetching — after approve/revert
   * the row's status just flips in place, so the operator can still see (and
   * revisit) what they just decided even when the active filter would exclude
   * it on the next fetch.
   */
  function renderCandidateList(): void {
    const list = el<HTMLDivElement>('hx-candidates-list');
    if (!list) return;
    list.textContent = '';

    let lastCiting = '';
    for (const c of state.candidates) {
      if (c.citing_book !== lastCiting) {
        lastCiting = c.citing_book;
        const group = document.createElement('div');
        group.className = 'hx-citing-group';
        group.textContent = c.citing_title ?? c.citing_book;
        group.title = `${c.citing_author ?? ''} ${c.citing_year ?? ''}`.trim();
        list.appendChild(group);
      }
      const row = buildRow(c);
      if (state.selected?.id === c.id) row.classList.add('hx-row-selected');
      list.appendChild(row);
    }

    renderAppliedSection();
    updateBatchButton();
  }

  /** The permanent per-scope record: every applied hypercite, always visible. */
  function renderAppliedSection(): void {
    const section = el<HTMLDivElement>('hx-applied-section');
    const list = el<HTMLDivElement>('hx-applied-list');
    const count = el<HTMLSpanElement>('hx-applied-count');
    if (!section || !list) return;

    section.hidden = state.applied.length === 0;
    if (count) count.textContent = String(state.applied.length);
    list.textContent = '';

    for (const c of state.applied) {
      const row = buildRow(c);
      // Flat section, so the row carries BOTH sides (the main list gets the
      // citing side from its group headers).
      const title = row.querySelector('.hx-row-title');
      if (title) title.textContent = `${c.citing_title ?? c.citing_book} → ${c.cited_title ?? c.cited_book}`;
      if (state.selected?.id === c.id) row.classList.add('hx-row-selected');
      list.appendChild(row);
    }
  }

  function buildRow(c: Candidate): HTMLElement {
    const row = document.createElement('div');
    row.className = 'hx-row';
    row.dataset.id = c.id;
    row.setAttribute('role', 'listitem');

    const title = document.createElement('span');
    title.className = 'hx-row-title';
    title.textContent = `→ ${c.cited_title ?? c.cited_book}`;
    row.appendChild(title);

    if (c.has_quote) {
      const q = document.createElement('span');
      q.className = 'hx-badge hx-badge-quote';
      q.textContent = c.quote_kind === 'blockquote' ? '❝ block' : '❝ quote';
      row.appendChild(q);
    }
    if (c.match_method) {
      const m = document.createElement('span');
      m.className = 'hx-badge';
      m.textContent = c.match_method === 'fts_fuzzy'
        ? `fuzzy ${Math.round((c.match_score ?? 0) * 100)}%`
        : c.match_method + ((c.match_occurrences ?? 1) > 1 ? ` ×${c.match_occurrences}` : '');
      row.appendChild(m);
    }
    const s = statusBadge(c);
    if (s) {
      const b = document.createElement('span');
      b.className = `hx-badge hx-badge-${c.status}`;
      b.textContent = s;
      row.appendChild(b);
    }

    row.addEventListener('click', () => select(c));
    return row;
  }

  /**
   * What to MARK in the citing pane: the quote beside the marker (found live,
   * nearest the marker offset — the stored text may have been truncated for
   * transport, and the node's text shifts once a ↗ is spliced in), the whole
   * blockquote, or failing both the claim sentence.
   */
  function citingMarks(c: Candidate): MarkSpec[] {
    if (c.quote_kind === 'inline' && c.quote_text) {
      const text = c.quote_text.replace(/\.\.\.$|…$/u, ''); // transport truncation
      return [{ nodeId: c.citing_node_id, search: { text, near: c.marker_offset } }];
    }
    if (c.quote_kind === 'blockquote' && c.quote_node_id) {
      return [{ nodeId: c.quote_node_id, wholeNode: true }];
    }
    if (c.claim_start !== null && c.claim_end !== null) {
      return [{ nodeId: c.citing_node_id, range: { start: c.claim_start, end: c.claim_end } }];
    }
    return [];
  }

  /**
   * What to MARK in the cited pane: the located span(s), exactly as charData
   * would store them. Skipped once applied — the real hypercite underline is
   * the mark then, and the pane deep-links to it.
   */
  function citedMarks(c: Candidate): MarkSpec[] {
    if (c.status === 'applied' || !c.match_char_data) return [];
    return Object.entries(c.match_char_data).map(([nodeId, span]) => ({
      nodeId,
      range: { start: span.charStart, end: span.charEnd },
    }));
  }

  function select(c: Candidate, forcePanes = false): void {
    state.selected = c;
    document.querySelectorAll('.hx-row').forEach((r) =>
      r.classList.toggle('hx-row-selected', (r as HTMLElement).dataset.id === c.id));

    // Hash targets must be what the reader's resolver understands: a NUMERIC
    // startLine (the node's DOM id) or a hypercite_ id — a data-node-id
    // resolves to nothing and the pane would open at the top of the book.
    // forcePanes reloads even under an unchanged URL — approve/revert just
    // changed the citing book's CONTENT (the ↗), not its URL.
    const citingTarget = c.citing_start_line !== null ? String(c.citing_start_line) : null;
    citingPane.show(c.citing_book, citingTarget, `citing — ${c.citing_title ?? c.citing_book}`, citingMarks(c), forcePanes);
    const citedTarget = c.status === 'applied' && c.hypercite_id
      ? c.hypercite_id
      : (c.cited_start_line !== null ? String(c.cited_start_line) : null);
    citedPane.show(c.cited_book, citedTarget, `cited — ${c.cited_title ?? c.cited_book}`, citedMarks(c), forcePanes);

    const card = el<HTMLDivElement>('hx-selected');
    const metaEl = el<HTMLDivElement>('hx-selected-meta');
    const quoteEl = el<HTMLQuoteElement>('hx-selected-quote');
    const approve = el<HTMLButtonElement>('hx-approve');
    const status = el<HTMLSpanElement>('hx-selected-status');
    if (!card || !metaEl || !quoteEl || !approve) return;

    card.hidden = false;
    const bits = [
      `ref ${c.reference_id}`,
      c.is_internal ? 'internal' : 'external',
      c.match_method ? `${c.match_method} ${(c.match_score ?? 0).toFixed(2)}` : null,
      (c.match_occurrences ?? 0) > 1 ? `${c.match_occurrences} occurrences — check it's the right one` : null,
      c.error,
    ].filter(Boolean);
    metaEl.textContent = bits.join(' · ');
    quoteEl.textContent = c.quote_text ?? '(no direct quote — citation-only candidate)';
    quoteEl.hidden = false;

    approve.disabled = c.status !== 'matched';
    approve.title = c.status === 'matched'
      ? 'Mint the hypercite'
      : `Not appliable from status "${c.status}"${c.has_quote ? '' : ' — no quote was detected'}`;
    const revert = el<HTMLButtonElement>('hx-revert');
    if (revert) revert.hidden = c.status !== 'applied';
    if (status) status.textContent = '';
  }

  /* ── Verdicts ── */

  el<HTMLButtonElement>('hx-approve')?.addEventListener('click', async () => {
    const c = state.selected;
    const status = el<HTMLSpanElement>('hx-selected-status');
    if (!c) return;
    if (status) status.textContent = 'minting…';
    try {
      const { status: http, data } = await api.approve(c.id);
      if (data.applied) {
        if (status) status.textContent = `✓ hypercited (${data.hyperciteId})`;
        // Flip in place, no refetch — the active filter would drop the row and
        // take the review context with it. select() re-runs so the card shows
        // ↩ revert and the cited pane lands on the real hypercite.
        c.status = 'applied';
        c.hypercite_id = data.hyperciteId ?? null;
        if (!state.applied.some((a) => a.id === c.id)) state.applied.unshift(c);
        renderCandidateList();
        select(c, true); // force: the citing pane's content changed under the same URL
        if (status) status.textContent = `✓ hypercited (${data.hyperciteId})`;
      } else if (http === 409) {
        if (status) status.textContent = `stale (${data.refusal}) — re-run detect, then re-review`;
      } else {
        if (status) status.textContent = data.message ?? `refused (${data.refusal ?? http})`;
      }
    } catch (err) {
      log.error('hypercites: approve failed', 'maintainer', err);
      if (status) status.textContent = 'approve failed — see console';
    }
  });

  el<HTMLButtonElement>('hx-revert')?.addEventListener('click', async () => {
    const c = state.selected;
    const status = el<HTMLSpanElement>('hx-selected-status');
    if (!c) return;
    if (status) status.textContent = 'reverting…';
    try {
      const { status: http, data } = await api.revert(c.id);
      if (data.reverted) {
        c.status = 'matched';
        c.hypercite_id = null;
        state.applied = state.applied.filter((a) => a.id !== c.id);
        renderCandidateList();
        select(c, true);
        if (status) status.textContent = '↩ reverted — back to matched';
      } else if (http === 409) {
        if (status) status.textContent = `stale (${data.refusal}) — the citing text changed since apply; remove by hand in the reader`;
      } else {
        if (status) status.textContent = data.message ?? `refused (${data.refusal ?? http})`;
      }
    } catch (err) {
      log.error('hypercites: revert failed', 'maintainer', err);
      if (status) status.textContent = 'revert failed — see console';
    }
  });

  el<HTMLButtonElement>('hx-reject')?.addEventListener('click', async () => {
    const c = state.selected;
    const status = el<HTMLSpanElement>('hx-selected-status');
    if (!c) return;
    try {
      const { data } = await api.reject(c.id);
      if (status) status.textContent = data.rejected ? '✕ rejected' : (data.message ?? 'not rejectable');
      if (data.rejected) await loadCandidates();
    } catch (err) {
      log.error('hypercites: reject failed', 'maintainer', err);
      if (status) status.textContent = 'reject failed — see console';
    }
  });

  /* ── Batch approve: offered only when the visible filter is the policy's
        shape (matched + exact), and the server re-checks every row anyway. ── */

  function updateBatchButton(): void {
    const btn = el<HTMLButtonElement>('hx-batch-approve');
    if (!btn) return;
    const f = filters();
    const eligible = f.status === 'matched' && f.match_method === 'exact'
      && state.candidates.filter((c) => c.status === 'matched' && c.match_method === 'exact').length > 0;
    btn.hidden = !eligible;
  }

  el<HTMLButtonElement>('hx-batch-approve')?.addEventListener('click', async () => {
    const ids = state.candidates
      .filter((c) => c.status === 'matched' && c.match_method === 'exact' && (c.match_occurrences ?? 1) === 1)
      .map((c) => c.id)
      .slice(0, 25);
    if (!ids.length) return;
    if (!window.confirm(`Approve ${ids.length} exact-match candidates? The server re-checks each against the policy.`)) return;
    setRunStatus('batch approving…');
    try {
      const { data } = await api.batchApprove(state.base, ids);
      setRunStatus(`batch: ${data.applied ?? 0} applied, ${data.skipped_policy ?? 0} skipped, ${data.failed ?? 0} failed`);
      await loadCandidates();
    } catch (err) {
      log.error('hypercites: batch approve failed', 'maintainer', err);
      setRunStatus('batch approve failed');
    }
  });

  /* ── Detect + poll ── */

  el<HTMLButtonElement>('hx-detect')?.addEventListener('click', async () => {
    const auto = el<HTMLInputElement>('hx-auto-approve')?.checked ?? false;
    setRunStatus('starting…');
    try {
      const { data } = await api.detect(state.base, auto);
      if (data.already_running) setRunStatus('a detect is already running — joining it');
      poll(data.run_id);
    } catch (err) {
      log.error('hypercites: detect failed to start', 'maintainer', err);
      setRunStatus('failed to start — see console');
    }
  });

  function poll(runId: string): void {
    if (state.pollTimer !== null) window.clearTimeout(state.pollTimer);
    state.pollingRunId = runId;
    const tick = async (): Promise<void> => {
      if (state.pollingRunId !== runId) return; // a newer poll took over
      try {
        const run: RunStatus = await api.runStatus(runId);
        if (run.status === 'completed') {
          state.pollingRunId = null;
          setRunStatus(`✓ ${run.step_detail ?? 'done'}`);
          await loadCandidates();
          return;
        }
        if (run.status === 'failed') {
          state.pollingRunId = null;
          setRunStatus(`✗ ${run.error ?? 'failed'}`);
          return;
        }
        setRunStatus(run.step_detail ?? run.status);
        state.pollTimer = window.setTimeout(tick, 2500);
      } catch (err) {
        state.pollingRunId = null;
        log.error('hypercites: poll failed', 'maintainer', err);
        setRunStatus('poll failed — refresh to check');
      }
    };
    void tick();
  }

  /* ── Most-cited tab ── */

  let mostCitedLoaded = false;

  async function loadMostCited(): Promise<void> {
    const external = el<HTMLDivElement>('hx-external-list');
    const internal = el<HTMLDivElement>('hx-internal-list');
    const count = el<HTMLSpanElement>('hx-mostcited-count');
    if (!external || !internal) return;

    try {
      const data = await api.mostCited(state.base);
      if (count) count.textContent = `${data.external.length} external · ${data.internal.length} internal`;
      external.textContent = '';
      internal.textContent = '';
      for (const r of data.external) external.appendChild(buildMostCitedRow(r));
      for (const r of data.internal) internal.appendChild(buildMostCitedRow(r));
      mostCitedLoaded = true;
    } catch (err) {
      log.error('hypercites: most-cited load failed', 'maintainer', err);
      if (count) count.textContent = 'failed to load';
    }
  }

  function buildMostCitedRow(r: MostCitedRow): HTMLElement {
    const row = document.createElement('div');
    row.className = 'hx-mc-row';
    row.setAttribute('role', 'listitem');

    const n = document.createElement('span');
    n.className = 'hx-mc-count';
    n.textContent = String(r.citing_count);
    n.title = `cited by ${r.citing_count} article(s) of this journal`;

    const t = document.createElement('span');
    t.className = 'hx-mc-title';
    t.textContent = `${r.title ?? '(untitled)'}${r.author ? ` — ${r.author}` : ''}${r.year ? ` (${r.year})` : ''}`;
    t.title = r.doi ?? '';

    row.append(n, t);

    if (r.held) {
      const b = document.createElement('span');
      b.className = 'hx-badge hx-badge-applied';
      b.textContent = 'held';
      row.appendChild(b);
    } else if (r.importable) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'hx-import-btn';
      btn.textContent = '⇩ import';
      btn.title = 'Fetch this OA work (may run OCR, charged to you). Re-run detect afterwards to match against it.';
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = 'importing…';
        try {
          const { data } = await api.importSource(state.base, r.canonical_id);
          if (data.run_id) pollImport(data.run_id, btn);
          else {
            btn.textContent = data.message ?? 'refused';
          }
        } catch (err) {
          log.error('hypercites: import-source failed', 'maintainer', err);
          btn.textContent = 'failed';
        }
      });
      row.appendChild(btn);
    } else {
      const b = document.createElement('span');
      b.className = 'hx-badge';
      b.textContent = r.is_oa ? 'nothing fetchable' : 'not OA';
      row.appendChild(b);
    }

    return row;
  }

  function pollImport(runId: string, btn: HTMLButtonElement): void {
    const tick = async (): Promise<void> => {
      try {
        const run = await api.runStatus(runId);
        if (run.status === 'completed') {
          btn.textContent = '✓ imported';
          return;
        }
        if (run.status === 'failed') {
          btn.textContent = `✗ ${run.error ?? 'failed'}`;
          btn.disabled = false;
          return;
        }
        window.setTimeout(tick, 2500);
      } catch {
        btn.textContent = 'poll failed';
      }
    };
    void tick();
  }

  /* ── Tabs, filters, help ── */

  const tabs: Array<[string, string]> = [
    ['hx-tab-candidates', 'hx-candidates-tab'],
    ['hx-tab-mostcited', 'hx-mostcited-tab'],
  ];
  for (const [tabId, panelId] of tabs) {
    el<HTMLButtonElement>(tabId)?.addEventListener('click', () => {
      for (const [t, p] of tabs) {
        const isActive = t === tabId;
        el<HTMLButtonElement>(t)?.classList.toggle('hx-tab-active', isActive);
        el<HTMLButtonElement>(t)?.setAttribute('aria-selected', String(isActive));
        const panel = el<HTMLDivElement>(p);
        if (panel) panel.hidden = !isActive;
      }
      if (panelId === 'hx-mostcited-tab' && !mostCitedLoaded) void loadMostCited();
    });
  }

  for (const id of ['hx-filter-status', 'hx-filter-method', 'hx-filter-internal']) {
    el<HTMLElement>(id)?.addEventListener('change', () => void loadCandidates());
  }

  void loadCandidates();
}

/* ────────────────────────────── Help + boot ────────────────────────────── */

function initHelp(): void {
  const toggle = el<HTMLButtonElement>('hx-help-toggle');
  const panel = el<HTMLDivElement>('hx-help-panel');
  if (!toggle || !panel) return;
  toggle.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute('aria-expanded', String(!panel.hidden));
  });
  el<HTMLButtonElement>('hx-help-close')?.addEventListener('click', () => {
    panel.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
  });
}

initHelp();
const boot = bootOf();
if (boot.slug || boot.shelfId) initDetail(boot);
else void initIndex();
