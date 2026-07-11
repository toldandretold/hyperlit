/**
 * VibeCSS backend API: generation request + balance pre-check, and the
 * vibes-gallery CRUD (mine/save/update/delete/public). Was the API half of
 * components/vibeCSS.js.
 *
 * BYO-key mode (native macOS shell with an active LLM profile): generate returns
 * 202 + the prompt; we execute it locally via the bridge (the user's key /
 * local model) and post the completion back — the server never calls an LLM and
 * never charges.
 */
import { isByoLlmActive } from '../../../aiProviders/profiles';
import { executeTicketRequest } from '../../../aiProviders/execute';

/** The `css_overrides` jsonb — a map of CSS custom-property/selector → value. */
export type CssOverrides = Record<string, string>;

/**
 * A `vibes` row as the gallery sees it (the SOLE `vibes` contract that reaches the client).
 * Mirrors `VibeController`'s mine/public/save responses; `creator_token` is hidden server-side.
 * `creator`/`pull_count` are only present on the PUBLIC gallery payload.
 */
export interface Vibe {
  id: string;
  name: string;
  prompt: string | null;
  css_overrides: CssOverrides;
  visibility: 'private' | 'public';
  source_creator?: string | null;
  pull_count?: number;
  creator?: string | null;
  created_at: string;
}

/** The save (POST /api/vibes) body — backend sets id/creator/created_at. */
export interface VibeInput {
  name: string;
  css_overrides: CssOverrides;
  prompt?: string | null;
  visibility?: 'private' | 'public';
  source_vibe_id?: string;
  source_creator?: string;
}

/** POST prompt to backend; returns overrides object on success. */
export async function submitVibeRequest(prompt: string): Promise<CssOverrides> {
  const csrfToken = (document.querySelector('meta[name="csrf-token"]') as any)?.content;
  if (!csrfToken) throw new Error('No CSRF token found');

  const byo = await isByoLlmActive();

  const response = await fetch('/api/vibe-css/generate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-TOKEN': csrfToken,
      'Accept': 'application/json',
    },
    credentials: 'same-origin',
    body: JSON.stringify({ prompt, client_inference: byo }),
  });

  const data = await response.json();

  // BYO leg: the server parked the prompt (202) — run it with the user's own
  // provider, then post the raw completion back for the server-side parse.
  if (response.status === 202 && data.needs_client_inference) {
    const result = await executeTicketRequest(data.request);
    if (!result || result.content === null) {
      const err: any = new Error('Your AI provider did not respond. Check your provider settings (⌘,).');
      err.status = 502;
      throw err;
    }

    const completeResp = await fetch('/api/vibe-css/complete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-TOKEN': csrfToken,
        'Accept': 'application/json',
      },
      credentials: 'same-origin',
      body: JSON.stringify({ ticket_id: data.ticket_id, content: result.content }),
    });
    const completeData = await completeResp.json();
    if (!completeResp.ok) {
      const err: any = new Error(completeData.message || 'Vibe generation failed');
      err.status = completeResp.status;
      err.data = completeData;
      throw err;
    }
    return completeData.overrides;
  }

  if (!response.ok) {
    const err: any = new Error(data.message || 'Vibe generation failed');
    err.status = response.status;
    err.data = data;
    throw err;
  }

  return data.overrides;
}

/** Lightweight balance pre-check. */
export async function checkBalance(): Promise<boolean> {
  const csrfToken = (document.querySelector('meta[name="csrf-token"]') as any)?.content;
  try {
    const response = await fetch('/api/vibe-css/can-proceed', {
      headers: {
        'Accept': 'application/json',
        'X-CSRF-TOKEN': csrfToken || '',
      },
      credentials: 'same-origin',
    });
    if (!response.ok) return false;
    const data = await response.json();
    return data.canProceed === true;
  } catch {
    return false;
  }
}

function getHeaders() {
  const csrfToken = (document.querySelector('meta[name="csrf-token"]') as any)?.content;
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-CSRF-TOKEN': csrfToken || '',
  };
}

export async function fetchMyVibes(): Promise<Vibe[]> {
  const resp = await fetch('/api/vibes/mine', {
    headers: getHeaders(),
    credentials: 'same-origin',
  });
  if (!resp.ok) return [];
  const data = await resp.json();
  return (data.vibes || []) as Vibe[];
}

export async function saveVibe({ name, css_overrides, prompt, visibility, source_vibe_id, source_creator }: VibeInput): Promise<Vibe> {
  const body: VibeInput = { name, css_overrides, prompt: prompt || null, visibility: visibility || 'private' };
  if (source_vibe_id) body.source_vibe_id = source_vibe_id;
  if (source_creator) body.source_creator = source_creator;
  const resp = await fetch('/api/vibes', {
    method: 'POST',
    headers: getHeaders(),
    credentials: 'same-origin',
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  if (!resp.ok) {
    const err: any = new Error(data.message || 'Failed to save vibe');
    err.status = resp.status;
    throw err;
  }
  return data.vibe as Vibe;
}

export async function updateVibe(id: string, fields: Partial<Vibe>): Promise<Vibe> {
  const resp = await fetch(`/api/vibes/${id}`, {
    method: 'PATCH',
    headers: getHeaders(),
    credentials: 'same-origin',
    body: JSON.stringify(fields),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.message || 'Failed to update vibe');
  return data.vibe as Vibe;
}

export async function deleteVibe(id: string): Promise<void> {
  const resp = await fetch(`/api/vibes/${id}`, {
    method: 'DELETE',
    headers: getHeaders(),
    credentials: 'same-origin',
  });
  if (!resp.ok) {
    const data = await resp.json();
    throw new Error(data.message || 'Failed to delete vibe');
  }
}

export async function fetchPublicVibes(offset: number = 0, sort = 'top'): Promise<{ vibes: Vibe[]; hasMore: boolean }> {
  const params = new URLSearchParams();
  if (offset) params.set('offset', String(offset));
  if (sort) params.set('sort', sort);
  const url = '/api/vibes/public' + (params.toString() ? '?' + params : '');
  const resp = await fetch(url, {
    headers: { 'Accept': 'application/json' },
    credentials: 'same-origin',
  });
  if (!resp.ok) return { vibes: [], hasMore: false };
  const data = await resp.json();
  return { vibes: (data.vibes || []) as Vibe[], hasMore: !!data.has_more };
}
