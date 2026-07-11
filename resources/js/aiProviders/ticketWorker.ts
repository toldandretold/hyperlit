/**
 * aiProviders/ticketWorker — the client half of BYO-key inference for
 * long-running server pipelines (citation review). The server parks its LLM
 * prompts as inference tickets; this worker polls `/api/inference/claim`,
 * executes each prompt with the user's own provider (via the native bridge),
 * and posts completions back so the blocked pipeline resumes.
 *
 * Lifecycle: start when a BYO pipeline is triggered, `stop()` when the
 * pipeline leaves its running states (the caller owns that signal — it is
 * already polling pipeline status). While active, a beforeunload warning
 * reminds the user the run needs this page open.
 */

import { executeTicketRequest, type TicketRequest } from './execute';
import { log, verbose } from '../utilities/logger';

const FILE = '/aiProviders/ticketWorker.ts';

/** How many tickets to claim (and run) per round. */
const CLAIM_LIMIT = 4;
/** Poll backoff when no tickets were waiting: 1s → 5s. */
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 5_000;

export interface TicketWorkerOptions {
  feature: 'ai_review' | 'ai_brain' | 'vibe_css';
  contextId?: string;
  /** Called after each round with how many tickets were processed. */
  onProgress?: (processed: number) => void;
}

export interface TicketWorkerHandle {
  stop: () => void;
  /** True until stop() is called. */
  isRunning: () => boolean;
}

function csrf(): string {
  return (document.querySelector('meta[name="csrf-token"]') as HTMLMetaElement | null)?.content ?? '';
}

interface ClaimedTicket {
  id: string;
  request: TicketRequest;
}

async function claimTickets(opts: TicketWorkerOptions): Promise<ClaimedTicket[]> {
  const resp = await fetch('/api/inference/claim', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-TOKEN': csrf(),
      'Accept': 'application/json',
    },
    credentials: 'same-origin',
    body: JSON.stringify({
      feature: opts.feature,
      context_id: opts.contextId ?? null,
      limit: CLAIM_LIMIT,
    }),
  });
  if (!resp.ok) return [];
  const data = await resp.json();
  return Array.isArray(data.tickets) ? data.tickets : [];
}

async function completeTicket(id: string, body: Record<string, unknown>): Promise<void> {
  await fetch(`/api/inference/${id}/complete`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-TOKEN': csrf(),
      'Accept': 'application/json',
    },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  });
}

/** Run one claimed ticket; failures post {error} so the pipeline degrades fast. */
async function runTicket(ticket: ClaimedTicket): Promise<void> {
  let body: Record<string, unknown>;
  try {
    const result = await executeTicketRequest(ticket.request || {});
    body = result && result.content !== null
      ? { content: result.content, usage: result.usage ?? null, model: result.model }
      : { error: 'Client provider returned no content' };
  } catch (e) {
    body = { error: String(e) };
  }
  await completeTicket(ticket.id, body);
}

/**
 * Start the claim→execute→complete loop. Returns a handle; the CALLER stops it
 * when the pipeline finishes (it owns the status polling).
 */
export function startTicketWorker(opts: TicketWorkerOptions): TicketWorkerHandle {
  let running = true;
  let backoff = BACKOFF_MIN_MS;
  let processedTotal = 0;

  const beforeUnload = (e: BeforeUnloadEvent) => {
    // The pipeline needs this page open to answer its prompts.
    e.preventDefault();
  };
  window.addEventListener('beforeunload', beforeUnload);

  const loop = async () => {
    verbose.init(`Ticket worker started (${opts.feature}${opts.contextId ? ` / ${opts.contextId}` : ''})`, FILE);
    while (running) {
      let processed = 0;
      try {
        const tickets = await claimTickets(opts);
        if (tickets.length > 0 && running) {
          await Promise.all(tickets.map((t) => runTicket(t)));
          processed = tickets.length;
          processedTotal += processed;
          opts.onProgress?.(processed);
        }
      } catch (e) {
        log.error('Ticket worker round failed', FILE, e);
      }

      if (!running) break;

      // Busy rounds re-poll immediately; idle rounds back off 1s → 5s.
      backoff = processed > 0 ? BACKOFF_MIN_MS : Math.min(backoff * 2, BACKOFF_MAX_MS);
      if (processed === 0) {
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
    verbose.init(`Ticket worker stopped after ${processedTotal} tickets`, FILE);
  };

  void loop();

  return {
    stop: () => {
      running = false;
      window.removeEventListener('beforeunload', beforeUnload);
    },
    isRunning: () => running,
  };
}
