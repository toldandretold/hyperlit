/**
 * SSE plumbing for the AI Brain endpoints, shared by the in-reader brain panel
 * (hyperlitContainer/brainQuery.ts → /api/ai-brain/query) and the hero-page
 * archivist panel (components/aiArchivist/archivistPanel.ts → /api/ai-brain/ask).
 * Extracted from brainQuery.ts; behaviour unchanged apart from logging via
 * the logger utility.
 */

import { executeTicketRequest } from '../../aiProviders/execute';
import { log } from '../../utilities/logger';

/**
 * BYO-key leg: the server parked an LLM prompt as an inference ticket and pushed
 * it over the SSE stream. Execute it with the user's own provider (via the
 * native bridge) and post the completion back so the blocked pipeline resumes.
 * Failures are posted as {error} so the stream fails fast instead of waiting
 * out the ticket TTL.
 */
export async function executeInferenceTicket(parsed: any, csrfToken: string): Promise<void> {
  const ticketId = parsed?.ticket_id;
  if (!ticketId) return;

  let body: any;
  try {
    const result = await executeTicketRequest(parsed.request || {});
    body = result && result.content !== null
      ? { content: result.content, usage: result.usage ?? null, model: result.model }
      : { error: 'Client provider returned no content' };
  } catch (e) {
    body = { error: String(e) };
  }

  try {
    await fetch(`/api/inference/${ticketId}/complete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-TOKEN': csrfToken,
        'Accept': 'application/json',
      },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
  } catch (e) {
    log.error('sseClient: failed to post inference completion', '/components/aiArchivist/sseClient.ts', e);
  }
}

export interface SseHandlers {
  /** A `status` event — a progress message for the step checklist. */
  onStatus?: (message: string) => void;
  /** An `inference_request` event — a BYO-key ticket to execute locally. */
  onInferenceRequest?: (parsed: any) => void;
  /** An `error` event — the stream-level failure message. */
  onError?: (message: string) => void;
  /** The final `result` event payload. */
  onResult?: (data: any) => void;
}

/**
 * Read an AI-brain SSE response body to completion, dispatching each event to
 * its handler. Line-buffered `event:` / `data:` parse, identical to the loop
 * this was extracted from.
 */
export async function readSseStream(body: ReadableStream<Uint8Array>, handlers: SseHandlers): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventType = 'message';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() || ''; // keep incomplete line
    for (const line of lines) {
      if (line.startsWith('event: ')) {
        eventType = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        try {
          const parsed = JSON.parse(line.slice(6));
          if (eventType === 'status') {
            handlers.onStatus?.(parsed.message);
          } else if (eventType === 'inference_request') {
            handlers.onInferenceRequest?.(parsed);
          } else if (eventType === 'error') {
            handlers.onError?.(parsed.message || 'AI query failed');
          } else if (eventType === 'result') {
            handlers.onResult?.(parsed);
          }
        } catch {
          log.warn('sseClient: failed to parse SSE data line', '/components/aiArchivist/sseClient.ts', line);
        }
        eventType = 'message';
      }
    }
  }
}
