// The PAID tier of auto-metadata: ship the book's opening plain text to
// POST /api/citation-meta/extract and get structured citation fields back.
//
// Encrypted books never reach here — the caller gates on isBookEncrypted, and
// the server refuses them anyway (403), because their plaintext must not leave
// the client. See docs/e2ee.md.
import { log, verbose } from '../../../utilities/logger';
import { isByoLlmActive } from '../../../aiProviders/profiles';
import { startTicketWorker } from '../../../aiProviders/ticketWorker';
import type { AiMetadata, AiRequestResult } from './types';

const FILE = '/components/sourceContainer/autoMetadata/remote.ts';

/** Matches the controller's own cap, so `max:` validation can never surprise us. */
export const AI_CHAR_LIMIT = 6000;
/** How many opening nodes the model gets to see. */
export const AI_NODE_LIMIT = 8;

function csrf(): string {
  return (document.querySelector('meta[name="csrf-token"]') as HTMLMetaElement | null)?.content ?? '';
}

function normalise(raw: Record<string, unknown> | null | undefined): AiMetadata {
  const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
  const conf = raw?.confidence;
  return {
    title: str(raw?.title),
    author: str(raw?.author),
    year: typeof raw?.year === 'number' && Number.isFinite(raw.year) ? raw.year : null,
    type: str(raw?.type),
    journal: str(raw?.journal),
    publisher: str(raw?.publisher),
    self_authored: raw?.self_authored === true,
    confidence: conf === 'high' || conf === 'low' ? conf : 'medium',
  };
}

/**
 * Ask the server to read `text` and return citation fields.
 *
 * BYO SEQUENCING TRAP: the endpoint is SYNCHRONOUS and blocks inside
 * ClientTicketTransport::poll() waiting for this client to answer its own
 * prompt. The ticket worker must therefore already be polling BEFORE the fetch
 * is issued — start it after and the request deadlocks until the server's wait
 * timeout expires.
 */
export async function requestAiMetadata(bookId: string, text: string): Promise<AiRequestResult> {
  const byo = await isByoLlmActive().catch(() => false);
  const worker = byo ? startTicketWorker({ feature: 'citation_meta', contextId: bookId }) : null;

  try {
    const resp = await fetch('/api/citation-meta/extract', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-CSRF-TOKEN': csrf(),
      },
      credentials: 'include',
      body: JSON.stringify({
        book: bookId,
        text: text.slice(0, AI_CHAR_LIMIT),
        client_inference: byo,
      }),
    });

    const data = await resp.json().catch(() => ({}) as Record<string, unknown>);

    if (!resp.ok) {
      verbose.content(`Auto metadata AI tier failed (${resp.status})`, FILE);
      return {
        ok: false,
        status: resp.status,
        message: typeof data.message === 'string' ? data.message : `Request failed (${resp.status})`,
      };
    }

    log.content('Auto metadata: AI read the text', FILE, { book: bookId, charged: data.charged ?? null });
    return {
      ok: true,
      metadata: normalise(data.metadata as Record<string, unknown>),
      cost: typeof data.cost === 'number' ? data.cost : null,
      charged: typeof data.charged === 'number' ? data.charged : null,
    };
  } catch (err) {
    log.error('Auto metadata: network error on AI tier', FILE, err);
    return { ok: false, status: 0, message: 'Network error — could not reach the server.' };
  } finally {
    worker?.stop();
  }
}

/** True when this request was answered by the user's own model, so nothing was charged. */
export function byoActive(): Promise<boolean> {
  return isByoLlmActive().catch(() => false);
}
