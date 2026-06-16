/**
 * VibeCSS backend API (leaf): generation request + balance pre-check, and the
 * vibes-gallery CRUD (mine/save/update/delete/public). Was the API half of
 * components/vibeCSS.js.
 */

/** POST prompt to backend; returns overrides object on success. */
export async function submitVibeRequest(prompt: string): Promise<any> {
  const csrfToken = (document.querySelector('meta[name="csrf-token"]') as any)?.content;
  if (!csrfToken) throw new Error('No CSRF token found');

  const response = await fetch('/api/vibe-css/generate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-TOKEN': csrfToken,
      'Accept': 'application/json',
    },
    credentials: 'same-origin',
    body: JSON.stringify({ prompt }),
  });

  const data = await response.json();

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

export async function fetchMyVibes(): Promise<any[]> {
  const resp = await fetch('/api/vibes/mine', {
    headers: getHeaders(),
    credentials: 'same-origin',
  });
  if (!resp.ok) return [];
  const data = await resp.json();
  return data.vibes || [];
}

export async function saveVibe({ name, css_overrides, prompt, visibility, source_vibe_id, source_creator }: any): Promise<any> {
  const body: any = { name, css_overrides, prompt: prompt || null, visibility: visibility || 'private' };
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
  return data.vibe;
}

export async function updateVibe(id: any, fields: any): Promise<any> {
  const resp = await fetch(`/api/vibes/${id}`, {
    method: 'PATCH',
    headers: getHeaders(),
    credentials: 'same-origin',
    body: JSON.stringify(fields),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.message || 'Failed to update vibe');
  return data.vibe;
}

export async function deleteVibe(id: any): Promise<void> {
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

export async function fetchPublicVibes(offset: any = 0, sort = 'top'): Promise<any> {
  const params = new URLSearchParams();
  if (offset) params.set('offset', offset);
  if (sort) params.set('sort', sort);
  const url = '/api/vibes/public' + (params.toString() ? '?' + params : '');
  const resp = await fetch(url, {
    headers: { 'Accept': 'application/json' },
    credentials: 'same-origin',
  });
  if (!resp.ok) return { vibes: [], hasMore: false };
  const data = await resp.json();
  return { vibes: data.vibes || [], hasMore: !!data.has_more };
}
