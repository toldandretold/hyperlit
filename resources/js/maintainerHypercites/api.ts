/**
 * Typed fetch layer for /maintainer/hypercites (see HyperciteConsoleController).
 * Every POST carries the CSRF pair via ensureCsrfToken, matching the other
 * maintainer consoles.
 */

import { ensureCsrfToken } from '../utilities/auth/csrf';

export interface JournalRow {
  slug: string;
  display_name: string;
  publisher: string | null;
  works_count: number | null;
  last_harvested_at: string | null;
  candidates: Record<string, number>;
}

export interface ShelfRow {
  shelf_id: string;
  name: string;
  creator: string;
  item_count: number;
  candidates: Record<string, number>;
}

export interface ScopeMeta {
  scope_type: 'journal' | 'shelf';
  slug?: string;
  shelf_id?: string;
  display_name: string;
  publisher: string | null;
}

export interface Candidate {
  id: string;
  status: 'pending' | 'matched' | 'no_match' | 'rejected' | 'applied' | 'failed';
  error: string | null;
  is_internal: boolean;
  citing_canonical_source_id: string;
  cited_canonical_source_id: string;
  citing_book: string;
  cited_book: string;
  reference_id: string;
  occurrence_index: number;
  citing_node_id: string;
  citing_start_line: number | string | null;
  cited_start_line: number | string | null;
  marker_offset: number;
  has_quote: boolean;
  quote_kind: 'inline' | 'blockquote' | null;
  quote_text: string | null;
  quote_node_id: string | null;
  match_node_ids: string[] | null;
  match_method: 'exact' | 'normalized' | 'fts_fuzzy' | null;
  match_score: number | null;
  match_occurrences: number | null;
  hypercite_id: string | null;
  auto_approved: boolean;
  reviewed_at: string | null;
  applied_at: string | null;
  citing_title: string | null;
  citing_author: string | null;
  citing_year: number | null;
  cited_title: string | null;
  cited_author: string | null;
  cited_year: number | null;
}

export interface CandidatesPayload {
  scope: ScopeMeta;
  status_counts: Record<string, number>;
  candidates: Candidate[];
}

export interface RunStatus {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  action: string;
  step_detail: string | null;
  counts: Record<string, unknown>;
  error: string | null;
}

export interface MostCitedRow {
  canonical_id: string;
  title: string | null;
  author: string | null;
  year: number | null;
  journal: string | null;
  doi: string | null;
  citing_count: number;
  cited_by_count: number | null;
  is_internal: boolean;
  held: boolean;
  is_oa: boolean;
  fetchable: boolean;
  importable: boolean;
}

export interface ApproveResult {
  applied: boolean;
  refusal?: string;
  message?: string;
  hyperciteId?: string;
  anchorId?: string;
  citedBook?: string;
  citedNodeId?: string;
}

async function csrfHeaders(): Promise<Record<string, string> | null> {
  const token = await ensureCsrfToken();
  if (!token) return null;
  return { 'X-XSRF-TOKEN': token, 'X-Requested-With': 'XMLHttpRequest' };
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json() as Promise<T>;
}

async function postJson<T>(url: string, body: Record<string, unknown>): Promise<{ status: number; data: T }> {
  const headers = await csrfHeaders();
  if (!headers) throw new Error('session error — refresh and retry');
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, data };
}

/**
 * The API base for one detection scope: journals live at .../{slug}, public
 * shelves at .../shelf/{uuid}. Everything scope-keyed hangs off this base.
 */
export function scopeBase(slug: string | null, shelfId: string | null): string {
  return slug
    ? `/api/maintainer/hypercites/${encodeURIComponent(slug)}`
    : `/api/maintainer/hypercites/shelf/${encodeURIComponent(shelfId ?? '')}`;
}

export const api = {
  journals: () => getJson<{ journals: JournalRow[]; shelves: ShelfRow[] }>('/api/maintainer/hypercites/journals'),

  candidates: (base: string, filters: Record<string, string>) => {
    const qs = new URLSearchParams(filters).toString();
    return getJson<CandidatesPayload>(`${base}/candidates${qs ? `?${qs}` : ''}`);
  },

  detect: (base: string, autoApprove: boolean) =>
    postJson<{ run_id: string; already_running: boolean; action?: string }>(
      `${base}/detect`,
      { auto_approve: autoApprove },
    ),

  runStatus: (id: string) => getJson<RunStatus>(`/api/maintainer/hypercites/runs/${encodeURIComponent(id)}`),

  approve: (id: string) =>
    postJson<ApproveResult>(`/api/maintainer/hypercites/candidates/${encodeURIComponent(id)}/approve`, {}),

  reject: (id: string) =>
    postJson<{ rejected?: boolean; message?: string }>(
      `/api/maintainer/hypercites/candidates/${encodeURIComponent(id)}/reject`,
      {},
    ),

  batchApprove: (base: string, ids: string[]) =>
    postJson<{ applied?: number; skipped_policy?: number; failed?: number; message?: string }>(
      `${base}/batch-approve`,
      { ids },
    ),

  mostCited: (base: string) =>
    getJson<{ internal: MostCitedRow[]; external: MostCitedRow[] }>(`${base}/most-cited`),

  importSource: (base: string, canonicalId: string) =>
    postJson<{ run_id: string; already_running: boolean; message?: string }>(
      `${base}/import-source`,
      { canonical_source_id: canonicalId },
    ),
};
