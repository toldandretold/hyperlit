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

it('multiple simultaneous audio generations all pass the balance check', function () {
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
            'node_id' => "node_{$i}",
            'content' => '<p>Some text to narrate</p>',
            'plainText' => 'Some text to narrate',
            'type' => 'p',
        ]);
        $books[] = $bookId;
    }

    $acceptedCount = 0;
    $insufficientCount = 0;

    // Simulate concurrent requests: all hit generate before any job charges.
    // In production these would be parallel HTTP requests; in the test they're
    // sequential but the charge is deferred to the job (Queue::fake), so the
    // balance never decrements between calls — exactly the race window.
    foreach ($books as $bookId) {
        $response = $this->postJson("/api/book-audio/{$bookId}/generate");

        if ($response->status() === 202) {
            $acceptedCount++;
        } elseif ($response->status() === 402) {
            $insufficientCount++;
        }
    }

    // VULNERABILITY: All 5 pass canProceed() because the balance check is
    // non-locking and the charge is deferred. A user with $0.01 can start
    // 5 generations that will each charge ~$1+ when the jobs complete.
    expect($acceptedCount)->toBe(5)
        ->and($insufficientCount)->toBe(0);

    // Confirm the jobs were dispatched (they would charge on completion)
    Queue::assertPushed(GenerateBookAudioJob::class, 5);
})->skip(
    'RACE CONDITION CONFIRMED: canProceed() is a non-locking read; charges are deferred to the job. '.
    'A user with $0.01 can start generation on N books simultaneously — all pass the check, '.
    'all jobs run, and the total charge drives the balance to -$(N-1).99. '.
    'Fix: either (a) reserve the estimated cost atomically before dispatch (lockForUpdate + increment debits), '.
    'or (b) use a per-user lock in canProceed, or (c) check balance again inside the job before generation starts. '.
    'Un-skip after implementing one of these.'
);

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
        'node_id' => 'n1',
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
