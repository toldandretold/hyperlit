<?php

use App\Models\InferenceTicket;
use Illuminate\Support\Facades\DB;

/**
 * Phase D — Vibe CSS + AI Brain routed over BYO-key inference tickets:
 * the 202/complete two-step for vibe CSS, the SSE inference_request leg for
 * AI Brain, and the no-charge guarantees.
 */

function rlsAs(string $name): void
{
    DB::statement("SELECT set_config('app.current_user', ?, false)", [$name]);
}

function billingRowsFor(int $userId): int
{
    return (int) DB::connection('pgsql_admin')->table('billing_ledger')->where('user_id', $userId)->count();
}

describe('Vibe CSS over BYO', function () {
    it('parks the prompt and returns 202 with the ticket instead of calling an LLM', function () {
        $user = $this->seedUser();

        $resp = $this->actingAs($user)->postJson('/api/vibe-css/generate', [
            'prompt' => 'neon cyberpunk',
            'client_inference' => true,
        ]);

        $resp->assertStatus(202)
            ->assertJsonPath('needs_client_inference', true)
            ->assertJsonStructure(['ticket_id', 'request' => ['messages', 'temperature', 'max_tokens']]);

        rlsAs($user->name);
        $ticket = InferenceTicket::find($resp->json('ticket_id'));
        expect($ticket)->not->toBeNull();
        expect($ticket->feature)->toBe('vibe_css');
        expect($ticket->status)->toBe('pending');

        // No LLM ran, no charge.
        expect(billingRowsFor($user->id))->toBe(0);
    });

    it('works without balance — BYO skips canProceed', function () {
        // seedUser gives no credits; the non-BYO path would 402.
        $user = $this->seedUser();

        $this->actingAs($user)->postJson('/api/vibe-css/generate', [
            'prompt' => 'warm sunset',
        ])->assertStatus(402);

        $this->actingAs($user)->postJson('/api/vibe-css/generate', [
            'prompt' => 'warm sunset',
            'client_inference' => true,
        ])->assertStatus(202);
    });

    it('re-arms the same prompt instead of tripping the dedupe index', function () {
        $user = $this->seedUser();

        $first = $this->actingAs($user)->postJson('/api/vibe-css/generate', [
            'prompt' => 'ocean breeze', 'client_inference' => true,
        ])->assertStatus(202)->json('ticket_id');

        $second = $this->actingAs($user)->postJson('/api/vibe-css/generate', [
            'prompt' => 'ocean breeze', 'client_inference' => true,
        ])->assertStatus(202)->json('ticket_id');

        expect($second)->toBe($first); // same row, re-armed
    });

    it('complete parses the client completion into overrides and charges nothing', function () {
        $user = $this->seedUser();

        $ticketId = $this->actingAs($user)->postJson('/api/vibe-css/generate', [
            'prompt' => 'forest morning', 'client_inference' => true,
        ])->json('ticket_id');

        $content = '<think>pondering</think>{"--color-background": "#0a1f0a", "--color-text": "#d8f3dc"}';

        $resp = $this->actingAs($user)->postJson('/api/vibe-css/complete', [
            'ticket_id' => $ticketId,
            'content' => $content,
        ]);

        $resp->assertOk()
            ->assertJsonPath('success', true)
            ->assertJsonPath('overrides.--color-background', '#0a1f0a');

        rlsAs($user->name);
        expect(InferenceTicket::find($ticketId)->status)->toBe('completed');
        expect(billingRowsFor($user->id))->toBe(0);
    });

    it('422s on an unparseable completion', function () {
        $user = $this->seedUser();
        $ticketId = $this->actingAs($user)->postJson('/api/vibe-css/generate', [
            'prompt' => 'gibberish test', 'client_inference' => true,
        ])->json('ticket_id');

        $this->actingAs($user)->postJson('/api/vibe-css/complete', [
            'ticket_id' => $ticketId,
            'content' => 'sorry, I cannot help with that',
        ])->assertStatus(422);
    });

    it('404s when completing another user\'s vibe ticket', function () {
        $owner = $this->seedUser();
        $attacker = $this->seedUser();

        $ticketId = $this->actingAs($owner)->postJson('/api/vibe-css/generate', [
            'prompt' => 'mine only', 'client_inference' => true,
        ])->json('ticket_id');

        $this->actingAs($attacker)->postJson('/api/vibe-css/complete', [
            'ticket_id' => $ticketId,
            'content' => '{"--color-text": "#fff"}',
        ])->assertNotFound();
    });
});

describe('AI Brain over BYO', function () {
    it('emits inference_request over SSE, creates the ticket, and never charges', function () {
        // Shrink the transport wait so the (unanswerable in-process) ticket
        // times out immediately → clean SSE error instead of a 300s hang.
        config()->set('services.llm.ticket_wait_seconds', 0);
        config()->set('services.llm.ticket_poll_seconds', 0);

        $user = $this->seedUser();
        $book = $this->seedLibrary(['book' => 'byo_brain_book', 'creator' => $user->name, 'visibility' => 'private', 'title' => 'BYO Test']);
        $this->seedNode(['book' => $book, 'startLine' => 1, 'node_id' => 'byo_brain_book_n1', 'content' => '<p>Some passage.</p>', 'plainText' => 'Some passage.']);

        $resp = $this->actingAs($user)->post('/api/ai-brain/query', [
            'selectedText' => 'Some passage worth asking about',
            'question' => 'What does this mean?',
            'bookId' => $book,
            'highlightId' => 'hl_byo_1',
            'nodeIds' => ['byo_brain_book_n1'],
            'charData' => ['byo_brain_book_n1' => []],
            'mode' => 'quick',
            'client_inference' => true,
        ], ['Accept' => 'text/event-stream']);

        $resp->assertOk();
        $stream = $resp->streamedContent();

        // The parked prompt was pushed to the client over the stream…
        expect($stream)->toContain('event: inference_request');
        expect($stream)->toContain('ticket_id');
        // …and with no client answering (wait=0), the stream failed cleanly.
        expect($stream)->toContain('did not answer in time');

        // The ticket exists, scoped to the highlight.
        rlsAs($user->name);
        $ticket = InferenceTicket::where('feature', 'ai_brain')->where('context_id', 'hl_byo_1')->first();
        expect($ticket)->not->toBeNull();

        // No charge in BYO mode.
        expect(billingRowsFor($user->id))->toBe(0);
    });

    it('still 402s without balance when BYO is NOT active', function () {
        $user = $this->seedUser();

        $this->actingAs($user)->postJson('/api/ai-brain/query', [
            'selectedText' => 'Some passage worth asking about',
            'question' => 'What does this mean?',
            'bookId' => 'any_book',
            'highlightId' => 'hl_x',
            'nodeIds' => ['n1'],
            'charData' => ['n1' => []],
            'mode' => 'quick',
        ])->assertStatus(402);
    });
});
