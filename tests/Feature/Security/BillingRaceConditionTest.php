<?php

/**
 * Penetration Tests: Billing Race Condition (Credit Overdraft)
 *
 * BookAudioController::generate checks BillingService::canProceed() — a
 * non-locking read of the user's balance — THEN dispatches GenerateBookAudioJob
 * which charges AFTER generation completes. The per-book Cache::lock prevents
 * duplicate generation for the SAME book, but a user can start generation for
 * MULTIPLE books simultaneously. Each passes canProceed() because the charge
 * hasn't happened yet, so all jobs run and the total charge can far exceed the
 * balance.
 *
 * Attack: A user with $0.01 balance starts audio generation for 20 books.
 * All 20 pass canProceed() (balance > 0). All 20 jobs run and charge ~$20.
 * The balance goes to -$19.99.
 */

use App\Jobs\GenerateBookAudioJob;
use App\Services\BillingService;
use Illuminate\Support\Facades\Queue;

beforeEach(function () {
    Queue::fake(); // prevent the job from actually running/charging
});

it('canProceed returns true with minimal balance (baseline)', function () {
    $user = $this->seedUser(['credits' => 0.01, 'debits' => 0]);
    $billing = app(BillingService::class);

    expect($billing->canProceed($user))->toBeTrue();
});

it('canProceed returns false with zero balance (baseline)', function () {
    $user = $this->seedUser(['credits' => 0, 'debits' => 0]);
    $billing = app(BillingService::class);

    expect($billing->canProceed($user))->toBeFalse();
});

it('multiple simultaneous audio generations are gated by credit reservation', function () {
    $user = $this->seedUser(['credits' => 0.01, 'debits' => 0]);
    $this->actingAs($user);

    // Create 5 books owned by the user with some nodes (needed for audio gen)
    $books = [];
    for ($i = 0; $i < 5; $i++) {
        $bookId = 'ssrf-audio-race-'.$i;
        $this->seedLibrary([
            'book' => $bookId,
            'title' => "Race Test Book {$i}",
            'creator' => $user->name,
            'creator_token' => $user->user_token,
            'visibility' => 'public',
        ]);
        $this->seedNode([
            'book' => $bookId,
            'startLine' => 100,
            // node_id is GLOBALLY unique — book-prefix it so residue from a
            // crashed run (admin seeds commit) can't collide with other tests.
            'node_id' => "{$bookId}_node_{$i}",
            'content' => '<p>Some text to narrate</p>',
            'plainText' => 'Some text to narrate',
            'type' => 'p',
        ]);
        $books[] = $bookId;
    }

    $acceptedCount = 0;
    $insufficientCount = 0;

    // Simulate concurrent requests: all hit generate before any job charges.
    // The credit reservation (reserveCredits) atomically increments debits
    // under a row lock — the first request reserves, subsequent requests see
    // a negative balance and get 402.
    foreach ($books as $bookId) {
        $response = $this->postJson("/api/book-audio/{$bookId}/generate");

        if ($response->status() === 202) {
            $acceptedCount++;
        } elseif ($response->status() === 402) {
            $insufficientCount++;
        }
    }

    // The reservation prevents the multi-book overdraft: at most 1 generation
    // is accepted (the first reservation consumes the $0.01 balance), the rest
    // get 402. (Exact count depends on the cost estimate, but the key invariant
    // is that NOT ALL 5 are accepted.)
    expect($acceptedCount)->toBeLessThan(5)
        ->and($insufficientCount)->toBeGreaterThan(0);
});

it('per-book lock prevents duplicate generation for the SAME book', function () {
    $user = $this->seedUser(['credits' => 100, 'debits' => 0]);
    $this->actingAs($user);

    $bookId = 'audio-lock-test';
    $this->seedLibrary([
        'book' => $bookId,
        'title' => 'Lock Test',
        'creator' => $user->name,
        'creator_token' => $user->user_token,
        'visibility' => 'public',
    ]);
    $this->seedNode([
        'book' => $bookId,
        'startLine' => 100,
        // Book-prefixed: an unprefixed 'n1' residue row from a crashed run
        // once broke every other test inserting node_id 'n1' (globally unique).
        'node_id' => "{$bookId}_n1",
        'content' => '<p>Text</p>',
        'plainText' => 'Text',
        'type' => 'p',
    ]);

    // First request acquires the per-book lock and dispatches
    $first = $this->postJson("/api/book-audio/{$bookId}/generate");
    expect($first->status())->toBe(202);

    // Second request for the SAME book hits the lock → 409
    $second = $this->postJson("/api/book-audio/{$bookId}/generate");
    expect($second->status())->toBe(409);
});

it('premium users bypass balance check entirely', function () {
    $user = $this->seedUser(['credits' => 0, 'debits' => 0, 'status' => 'premium']);
    $billing = app(BillingService::class);

    // Premium users always pass canProceed regardless of balance.
    // This is by design, but means the race condition doesn't apply to them.
    expect($billing->canProceed($user))->toBeTrue();
});
