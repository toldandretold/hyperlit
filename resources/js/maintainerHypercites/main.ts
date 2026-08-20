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
import { ReaderPane } from './panes';

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
  selected: Candidate | null;
  pollTimer: number | null;
}

function initDetail(boot: ConsoleBoot): void {
  const state: DetailState = {
    base: scopeBase(boot.slug, boot.shelfId),
    candidates: [],
    selected: null,
    pollTimer: null,
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
      const payload = await api.candidates(state.base, filters());
      state.candidates = payload.candidates;

      const title = el<HTMLHeadingElement>('hx-title');
      if (title) title.textContent = payload.scope.display_name;
      const meta = el<HTMLSpanElement>('hx-journal-meta');
      if (meta) meta.textContent = payload.scope.publisher ?? '';

      const total = Object.values(payload.status_counts).reduce((a, b) => a + b, 0);
      if (count) {
        count.textContent = `${payload.candidates.length} shown · ${total} total`
          + (payload.status_counts.applied ? ` · ${payload.status_counts.applied} applied` : '');
      }

      list.textContent = '';
      if (empty) empty.hidden = payload.candidates.length > 0 || total > 0;

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
        list.appendChild(buildRow(c));
      }

      updateBatchButton();
    } catch (err) {
      log.error('hypercites: candidates load failed', 'maintainer', err);
      if (count) count.textContent = 'failed to load';
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

  function select(c: Candidate): void {
    state.selected = c;
    document.querySelectorAll('.hx-row').forEach((r) =>
      r.classList.toggle('hx-row-selected', (r as HTMLElement).dataset.id === c.id));

    citingPane.show(c.citing_book, c.citing_node_id, `citing — ${c.citing_title ?? c.citing_book}`);
    const citedTarget = c.status === 'applied' && c.hypercite_id
      ? c.hypercite_id
      : (c.match_node_ids?.[0] ?? null);
    if (citedTarget || c.cited_book) {
      citedPane.show(c.cited_book, citedTarget, `cited — ${c.cited_title ?? c.cited_book}`);
    }

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
        c.status = 'applied';
        c.hypercite_id = data.hyperciteId ?? null;
        if (data.citedBook) citedPane.show(data.citedBook, data.hyperciteId ?? null, `cited — ${c.cited_title ?? data.citedBook}`);
        await loadCandidates();
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
    const tick = async (): Promise<void> => {
      try {
        const run: RunStatus = await api.runStatus(runId);
        if (run.status === 'completed') {
          setRunStatus(`✓ ${run.step_detail ?? 'done'}`);
          await loadCandidates();
          return;
        }
        if (run.status === 'failed') {
          setRunStatus(`✗ ${run.error ?? 'failed'}`);
          return;
        }
        setRunStatus(run.step_detail ?? run.status);
        state.pollTimer = window.setTimeout(tick, 2500);
      } catch (err) {
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
