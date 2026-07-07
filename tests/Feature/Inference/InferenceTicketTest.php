<?php

use App\Models\InferenceTicket;
use App\Services\Llm\ClientInferenceUnavailableException;
use App\Services\Llm\ClientTicketTransport;
use App\Services\Llm\InferenceTransport;
use App\Services\LlmService;
use Illuminate\Support\Facades\DB;

/**
 * Phase C — the BYO-key inference-ticket seam: the ClientTicketTransport, the
 * LlmService transport hook, and the claim/complete API under RLS.
 */

/** Set the RLS session user so model reads/writes on the default connection pass. */
function actAsRls(string $name): void
{
    DB::statement("SELECT set_config('app.current_user', ?, false)", [$name]);
}

/** The OpenAI body the transport hashes; matches LlmService::assembleBody output. */
function sampleBody(string $model = 'test-model'): array
{
    return [
        'model' => $model,
        'temperature' => 0.0,
        'max_tokens' => 10,
        'messages' => [
            ['role' => 'system', 'content' => 'sys'],
            ['role' => 'user', 'content' => 'hi'],
        ],
    ];
}

function hashOf(array $body): string
{
    return hash('sha256', json_encode([
        $body['model'] ?? null,
        $body['temperature'] ?? null,
        $body['max_tokens'] ?? null,
        $body['messages'] ?? null,
        $body['reasoning_effort'] ?? null,
    ]));
}

describe('ClientTicketTransport', function () {
    it('returns a matching completed ticket instantly (dedupe = resume checkpoint)', function () {
        $user = $this->seedUser();
        actAsRls($user->name);
        $body = sampleBody();

        InferenceTicket::create([
            'creator' => $user->name,
            'feature' => 'ai_brain',
            'context_id' => null,
            'request_hash' => hashOf($body),
            'status' => 'completed',
            'request' => $body,
            'completion' => ['content' => 'ANSWER'],
            'expires_at' => now()->addMinutes(5),
        ]);

        $transport = new ClientTicketTransport($user->name, 'ai_brain', null, pollIntervalSeconds: 0);

        expect($transport->execute($body, 30))->toBe('ANSWER');
    });

    it('creates a pending ticket and fires onTicketCreated', function () {
        $user = $this->seedUser();
        actAsRls($user->name);

        $seen = null;
        $transport = new ClientTicketTransport(
            $user->name, 'vibe_css', null,
            onTicketCreated: function (InferenceTicket $t) use (&$seen) { $seen = $t->id; },
            waitTimeoutSeconds: 0, // don't block; we only assert creation
            pollIntervalSeconds: 0
        );

        // waitTimeout 0 ⇒ poll throws immediately, but the ticket is created first.
        expect(fn () => $transport->execute(sampleBody(), 30))
            ->toThrow(ClientInferenceUnavailableException::class);

        expect($seen)->not->toBeNull();
        expect(InferenceTicket::where('creator', $user->name)->where('status', 'pending')->count())->toBe(1);
    });

    it('throws when a pending ticket is already past its expiry', function () {
        $user = $this->seedUser();
        actAsRls($user->name);
        $body = sampleBody();

        InferenceTicket::create([
            'creator' => $user->name,
            'feature' => 'ai_review',
            'context_id' => 'pipe1',
            'request_hash' => hashOf($body),
            'status' => 'pending',
            'request' => $body,
            'expires_at' => now()->subMinute(),
        ]);

        $transport = new ClientTicketTransport($user->name, 'ai_review', 'pipe1', pollIntervalSeconds: 0);

        expect(fn () => $transport->execute($body, 30))
            ->toThrow(ClientInferenceUnavailableException::class);
    });
});

describe('LlmService transport seam', function () {
    it('routes chat() through the transport, and clearTransport() restores normal behaviour', function () {
        // No server key ⇒ the normal path returns null without any HTTP call.
        config(['services.llm.api_key' => '', 'services.llm.base_url' => '']);

        $fake = new class implements InferenceTransport {
            public int $calls = 0;
            public function execute(array $body, int $timeout): ?string { $this->calls++; return 'FROM_CLIENT'; }
            public function executeBatch(array $bodies, int $timeout): array { $this->calls++; return array_map(fn () => 'FROM_CLIENT', $bodies); }
        };

        $svc = app(LlmService::class);
        $svc->setTransport($fake);

        expect($svc->chat('sys', 'hi'))->toBe('FROM_CLIENT');
        expect($fake->calls)->toBe(1);

        $svc->clearTransport();

        // Back to normal: no transport, no key ⇒ null, and the fake is untouched.
        expect($svc->chat('sys', 'hi'))->toBeNull();
        expect($fake->calls)->toBe(1);
    });
});

describe('claim/complete API (RLS-scoped)', function () {
    it('claims own pending tickets and marks them claimed', function () {
        $user = $this->seedUser();
        actAsRls($user->name);
        $ticket = InferenceTicket::create([
            'creator' => $user->name, 'feature' => 'ai_review', 'context_id' => 'p1',
            'request_hash' => hashOf(sampleBody()), 'status' => 'pending',
            'request' => sampleBody(), 'expires_at' => now()->addMinutes(5),
        ]);

        $this->actingAs($user)
            ->postJson('/api/inference/claim', ['feature' => 'ai_review'])
            ->assertOk()
            ->assertJsonPath('tickets.0.id', $ticket->id);

        expect(InferenceTicket::find($ticket->id)->status)->toBe('claimed');
    });

    it('never surfaces another user\'s tickets', function () {
        $owner = $this->seedUser();
        $other = $this->seedUser();
        actAsRls($owner->name);
        InferenceTicket::create([
            'creator' => $owner->name, 'feature' => 'ai_review', 'context_id' => null,
            'request_hash' => hashOf(sampleBody()), 'status' => 'pending',
            'request' => sampleBody(), 'expires_at' => now()->addMinutes(5),
        ]);

        $this->actingAs($other)
            ->postJson('/api/inference/claim', ['feature' => 'ai_review'])
            ->assertOk()
            ->assertExactJson(['tickets' => []]);
    });

    it('completes a claimed ticket with content', function () {
        $user = $this->seedUser();
        actAsRls($user->name);
        $ticket = InferenceTicket::create([
            'creator' => $user->name, 'feature' => 'vibe_css', 'context_id' => null,
            'request_hash' => hashOf(sampleBody()), 'status' => 'claimed',
            'request' => sampleBody(), 'expires_at' => now()->addMinutes(5),
        ]);

        $this->actingAs($user)
            ->postJson("/api/inference/{$ticket->id}/complete", ['content' => 'DONE', 'model' => 'llama3'])
            ->assertOk()
            ->assertJsonPath('status', 'completed');

        $fresh = InferenceTicket::find($ticket->id);
        expect($fresh->status)->toBe('completed');
        expect($fresh->completion['content'])->toBe('DONE');
    });

    it('404s when completing a ticket you do not own', function () {
        $owner = $this->seedUser();
        $attacker = $this->seedUser();
        actAsRls($owner->name);
        $ticket = InferenceTicket::create([
            'creator' => $owner->name, 'feature' => 'ai_brain', 'context_id' => null,
            'request_hash' => hashOf(sampleBody()), 'status' => 'claimed',
            'request' => sampleBody(), 'expires_at' => now()->addMinutes(5),
        ]);

        $this->actingAs($attacker)
            ->postJson("/api/inference/{$ticket->id}/complete", ['content' => 'HIJACK'])
            ->assertNotFound();

        // The attacker request left the RLS context as the attacker; switch back
        // to the owner to read the (untouched) ticket.
        actAsRls($owner->name);
        expect(InferenceTicket::find($ticket->id)->status)->toBe('claimed');
    });
});
