<?php

namespace App\Services\Llm;

use App\Models\InferenceTicket;
use Closure;

/**
 * The BYO-key transport: parks each LLM request as an inference_tickets row and
 * waits for the native client to post the completion back.
 *
 * Checkpoint/resume falls out of the dedupe key: if a ticket for the same
 * (creator, feature, context, request_hash) already completed, we return its
 * answer instantly — so a paused-and-resumed pipeline replays answered prompts
 * without re-issuing them.
 *
 * The caller (LlmService) MUST clear the transport when done — see
 * LlmService::clearTransport (it's a singleton; a stale transport would ticketise
 * the next job's calls).
 */
class ClientTicketTransport implements InferenceTransport
{
    /**
     * @param string       $creator          owning user (= app.current_user)
     * @param string       $feature          'vibe_css' | 'ai_brain' | 'ai_review'
     * @param string|null  $contextId        pipeline/highlight id, or null
     * @param Closure|null $onTicketCreated  fn(InferenceTicket): void — e.g. emit an SSE event
     * @param Closure|null $onWait           fn(): void — called each poll tick (e.g. SSE heartbeat)
     * @param int          $ttlSeconds       ticket lifetime
     * @param int          $waitTimeoutSeconds  how long execute() blocks before giving up
     * @param int          $pollIntervalSeconds poll cadence (0 in tests)
     */
    public function __construct(
        private string $creator,
        private string $feature,
        private ?string $contextId = null,
        private ?Closure $onTicketCreated = null,
        private ?Closure $onWait = null,
        private int $ttlSeconds = 300,
        private int $waitTimeoutSeconds = 300,
        private int $pollIntervalSeconds = 1,
    ) {
    }

    public function execute(array $body, int $timeout): ?string
    {
        $ticket = $this->upsertTicket($body);
        if ($ticket->status === 'completed') {
            return $this->contentOf($ticket);
        }
        if ($ticket->status === 'failed') {
            return null;
        }
        return $this->poll($ticket);
    }

    public function executeBatch(array $bodies, int $timeout): array
    {
        // Create every ticket first so the client can run them concurrently…
        $tickets = [];
        foreach ($bodies as $key => $body) {
            $tickets[$key] = $this->upsertTicket($body);
        }
        // …then collect (returning cached completions immediately).
        $results = [];
        foreach ($tickets as $key => $ticket) {
            $results[$key] = match ($ticket->status) {
                'completed' => $this->contentOf($ticket),
                'failed' => null,
                default => $this->poll($ticket),
            };
        }
        return $results;
    }

    /** Find-or-create the ticket for this request; revive an expired one. */
    private function upsertTicket(array $body): InferenceTicket
    {
        $hash = $this->requestHash($body);

        $query = InferenceTicket::query()
            ->where('creator', $this->creator)
            ->where('feature', $this->feature)
            ->where('request_hash', $hash);
        $this->contextId === null
            ? $query->whereNull('context_id')
            : $query->where('context_id', $this->contextId);

        $existing = $query->first();
        if ($existing) {
            // A previously expired ticket for the same prompt: re-arm it so the
            // client can answer on this (resumed) run.
            if ($existing->status === 'expired') {
                $existing->update([
                    'status' => 'pending',
                    'error' => null,
                    'expires_at' => now()->addSeconds($this->ttlSeconds),
                    'claimed_at' => null,
                ]);
                $this->fireCreated($existing);
            }
            return $existing;
        }

        $ticket = InferenceTicket::create([
            'creator' => $this->creator,
            'feature' => $this->feature,
            'context_id' => $this->contextId,
            'request_hash' => $hash,
            'status' => 'pending',
            'request' => $body,
            'expires_at' => now()->addSeconds($this->ttlSeconds),
        ]);
        $this->fireCreated($ticket);
        return $ticket;
    }

    /** Block until the client completes/fails the ticket, or it expires. */
    private function poll(InferenceTicket $ticket): ?string
    {
        $deadline = now()->addSeconds($this->waitTimeoutSeconds);

        while (now()->lt($deadline)) {
            $ticket->refresh();

            if ($ticket->status === 'completed') {
                return $this->contentOf($ticket);
            }
            if ($ticket->status === 'failed') {
                return null;
            }
            if ($ticket->status === 'expired' || now()->greaterThan($ticket->expires_at)) {
                throw new ClientInferenceUnavailableException(
                    "Inference ticket {$ticket->id} expired before the client answered"
                );
            }

            if ($this->onWait) {
                ($this->onWait)();
            }
            if ($this->pollIntervalSeconds > 0) {
                sleep($this->pollIntervalSeconds);
            }
        }

        throw new ClientInferenceUnavailableException(
            "Timed out waiting for the client to answer inference ticket {$ticket->id}"
        );
    }

    private function contentOf(InferenceTicket $ticket): ?string
    {
        $content = $ticket->completion['content'] ?? null;
        return is_string($content) ? $content : null;
    }

    private function fireCreated(InferenceTicket $ticket): void
    {
        if ($this->onTicketCreated) {
            ($this->onTicketCreated)($ticket);
        }
    }

    /**
     * Deterministic hash of the request's semantic content — the dedupe /
     * checkpoint key. Only the fields that change the answer.
     */
    private function requestHash(array $body): string
    {
        return hash('sha256', json_encode([
            $body['model'] ?? null,
            $body['temperature'] ?? null,
            $body['max_tokens'] ?? null,
            $body['messages'] ?? null,
            $body['reasoning_effort'] ?? null,
        ]));
    }
}
