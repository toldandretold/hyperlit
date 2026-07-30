// Shared timed POST for the sourceVerify flows (book-level + reference-level).
// The lookup/verify endpoints proxy LIVE external catalogues (OpenAlex / Open
// Library / Semantic Scholar); when those throttle or stall, the server response
// can take a long time — and a fetch with no deadline leaves the "Checking…"
// button hung for as long as the browser lets the request run (minutes). The
// server side now fails fast on 429s, so a healthy response arrives in seconds;
// this deadline is the last-resort safety net that guarantees the UI always
// comes back with a retryable message.
export const LOOKUP_TIMEOUT_MS = 60_000;

export const BUSY_MESSAGE =
  'External catalogues are busy right now — please try again in a minute.';

function csrfToken(): string {
  return (document.querySelector('meta[name="csrf-token"]') as HTMLMetaElement | null)?.content ?? '';
}

/** POST JSON with the standard sourceVerify headers and a hard deadline. */
export async function timedPost(url: string, body: string, timeoutMs: number = LOOKUP_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-CSRF-TOKEN': csrfToken(),
      },
      credentials: 'include',
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** True when a timedPost rejection was the deadline firing (vs a genuine network error). */
export function isTimeoutError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}
