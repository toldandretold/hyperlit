/**
 * Typed fetch layer for /maintainer/study (see Maintainer\StudyConsoleController).
 * Every POST carries the CSRF pair via ensureCsrfToken, matching the other
 * maintainer consoles.
 */

import { ensureCsrfToken } from '../utilities/auth/csrf';

export interface BookSummary {
  slug: string;
  arm: 'synthetic' | 'retracted' | 'control';
  title: string;
  run_id: string | null;
  run_status: string;
  counts: { total: number; flagged: number; adjudicated: number };
}

export interface CorpusSummary {
  corpus: string;
  frozen: boolean;
  books: BookSummary[];
}

export interface TriageInfo {
  status: string;
  invented_tokens: string;
  diffs: string;
}

export interface Adjudication {
  gt_id: string | null;
  referenceId: string | null;
  run_id: string | null;
  label: string;
  cause: string | null;
  note: string | null;
  found_url?: string | null;
  adjudicated_at: string;
  adjudicated_by: string;
}

export interface ClaimSource {
  found: boolean;
  book_id: string | null;
  title: string | null;
  author: string | null;
  year: string | number | null;
  url: string | null;
  doi: string | null;
  match_method: string | null;
  match_score: string | number | null;
  verification_tier: string | null;
  evidence_type: string | null;
  passages: unknown[];
}

export interface ClaimRow {
  key: string;
  referenceId: string | null;
  node_id: string | null;
  citation_row: string | null;
  verdict: string;
  truth_claim: string | null;
  contextualised_claim: string | null;
  bib_citation: string | null;
  llm_metadata: Record<string, unknown> | null;
  llm_verdict: { support?: string; summary?: string; reasoning?: string } | null;
  source: ClaimSource;
  source_material_sent: string | null;
  gt: {
    gt_id: string;
    label: string;
    footnote_marker: string | null;
    corruption_meta: Record<string, unknown> | null;
  } | null;
  triage: TriageInfo | null;
  adjudication: Adjudication | null;
}

export interface BookPayload {
  corpus: string;
  frozen: boolean;
  slug: string;
  arm: string;
  provenance: Record<string, unknown>;
  source_book_id: string | null;
  run_id: string | null;
  run_status: string;
  claims: ClaimRow[];
  counts: { total: number; flagged: number; adjudicated: number };
}

export interface PdfHit {
  page: number;
  snippet: string;
}

export interface NodeHit {
  node_id: string;
  snippet: string;
}

export interface NodeSearchResult {
  query: string;
  hits: NodeHit[];
  truncated: boolean;
}

export interface PdfSearchResult {
  pdf_book_id: string;
  query: string;
  hits: PdfHit[];
  truncated: boolean;
}

async function csrfHeaders(): Promise<Record<string, string> | null> {
  const token = await ensureCsrfToken();
  if (!token) return null;
  return { 'X-XSRF-TOKEN': token, 'X-Requested-With': 'XMLHttpRequest' };
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return (await res.json()) as T;
}

async function postJson<T>(
  url: string,
  body: Record<string, unknown>,
): Promise<{ status: number; data: T }> {
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

function corpusQs(corpus: string): string {
  return `?corpus=${encodeURIComponent(corpus)}`;
}

export const api = {
  books: (corpus: string) =>
    getJson<CorpusSummary>(`/api/maintainer/study/books${corpusQs(corpus)}`),

  claims: (corpus: string, slug: string) =>
    getJson<BookPayload>(
      `/api/maintainer/study/books/${encodeURIComponent(slug)}${corpusQs(corpus)}`,
    ),

  adjudicate: (
    corpus: string,
    slug: string,
    body: {
      key: string;
      label: string;
      cause: string | null;
      note: string | null;
      found_url: string | null;
      referenceId: string | null;
      run_id: string | null;
    },
  ) =>
    postJson<{ ok?: boolean; adjudication?: Adjudication; error?: string }>(
      `/api/maintainer/study/books/${encodeURIComponent(slug)}/adjudicate${corpusQs(corpus)}`,
      body,
    ),

  retract: (corpus: string, slug: string, key: string) =>
    postJson<{ ok?: boolean; removed?: boolean; error?: string }>(
      `/api/maintainer/study/books/${encodeURIComponent(slug)}/retract${corpusQs(corpus)}`,
      { key },
    ),

  apply: (corpus: string, slug: string) =>
    postJson<{ ok?: boolean; applied?: number; skipped?: string[]; error?: string }>(
      `/api/maintainer/study/books/${encodeURIComponent(slug)}/apply${corpusQs(corpus)}`,
      {},
    ),

  nodeSearch: async (
    corpus: string,
    slug: string,
    q: string,
  ): Promise<{ status: number; data: NodeSearchResult & { error?: string } }> => {
    const res = await fetch(
      `/api/maintainer/study/node-search/${encodeURIComponent(slug)}${corpusQs(corpus)}&q=${encodeURIComponent(q)}`,
      { credentials: 'include' },
    );
    const data = (await res.json().catch(() => ({}))) as NodeSearchResult & { error?: string };
    return { status: res.status, data };
  },

  pdfSearch: async (
    corpus: string,
    slug: string,
    q: string,
  ): Promise<{ status: number; data: PdfSearchResult & { error?: string } }> => {
    const res = await fetch(
      `/api/maintainer/study/pdf-search/${encodeURIComponent(slug)}${corpusQs(corpus)}&q=${encodeURIComponent(q)}`,
      { credentials: 'include' },
    );
    const data = (await res.json().catch(() => ({}))) as PdfSearchResult & { error?: string };
    return { status: res.status, data };
  },
};
