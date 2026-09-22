<?php

/**
 * Notification READ side (NotificationController): the paged feed, the unread
 * count for the pink dot, and mark-all-read. Everything runs on the default
 * connection where RLS scopes rows to the recipient — the isolation test is
 * the point, not a nicety.
 */

use Illuminate\Support\Facades\DB;

// cleanupApiFixtures defers internally (past the rollback) — see InteractsWithApi.
afterEach(fn () => $this->cleanupApiFixtures());

function seedNotification(string $recipient, array $attrs = []): int
{
    return DB::connection('pgsql_admin')->table('notifications')->insertGetId(array_merge([
        'recipient' => $recipient,
        'actor' => 'someone_else',
        'type' => 'hyperlight',
        'book' => 'apitest_notifbook',
        'root_book' => 'apitest_notifbook',
        'subject_id' => 'hyperlight_'.uniqid(),
        'data' => json_encode(['context_label' => 'your book “T”', 'snippet' => null]),
        'created_at' => now(),
    ], $attrs));
}

test('GET /api/notifications requires auth', function () {
    $this->getJson('/api/notifications')->assertStatus(401);
    $this->getJson('/api/notifications/unread-count')->assertStatus(401);
    $this->postJson('/api/notifications/read')->assertStatus(401);
});

test('the feed returns only the caller\'s rows (RLS isolation), render-ready', function () {
    $me = $this->loginUser();
    $other = $this->apiUser();
    seedNotification($me->name, ['type' => 'like', 'subject_id' => null, 'actor' => null]);
    seedNotification($me->name, ['type' => 'hypercite_paired', 'citing_ref' => '/citing#hypercite_a']);
    seedNotification($other->name);

    $resp = $this->getJson('/api/notifications')->assertStatus(200);
    expect($resp->json('total'))->toBe(2);
    expect($resp->json('unread_count'))->toBe(2);

    $items = collect($resp->json('items'));
    expect($items)->toHaveCount(2);
    // Newest first; render-ready fields present.
    $like = $items->firstWhere('type', 'like');
    expect($like['actor_label'])->toBe('Someone');
    expect($like['verb'])->toBe('liked');
    expect($like['link'])->toBe('/apitest_notifbook');
    $cite = $items->firstWhere('type', 'hypercite_paired');
    expect($cite['verb'])->toBe('cited');
    expect($cite['link'])->toBe('/citing#hypercite_a'); // link goes to THEIR citation
});

test('a hyperlight item links to the highlight anchor', function () {
    $me = $this->loginUser();
    seedNotification($me->name, ['book' => 'apitest_b1', 'subject_id' => 'hyperlight_q']);

    $item = $this->getJson('/api/notifications')->json('items.0');
    expect($item['link'])->toBe('/apitest_b1#hyperlight_q');
    expect($item['actor_label'])->toBe('someone_else');
    expect($item['verb'])->toBe('highlighted');
});

test('mark-read zeroes the unread count and stamps read_at; other users unaffected', function () {
    $me = $this->loginUser();
    $other = $this->apiUser();
    seedNotification($me->name);
    seedNotification($me->name);
    seedNotification($other->name);

    expect($this->getJson('/api/notifications/unread-count')->json('unread'))->toBe(2);

    $this->postJson('/api/notifications/read')
        ->assertStatus(200)
        ->assertJson(['success' => true, 'marked' => 2]);

    expect($this->getJson('/api/notifications/unread-count')->json('unread'))->toBe(0);
    expect($this->getJson('/api/notifications')->json('items.0.read_at'))->not->toBeNull();

    // The other user's row is untouched (RLS-scoped UPDATE).
    $admin = DB::connection('pgsql_admin');
    expect($admin->table('notifications')->where('recipient', $other->name)->whereNull('read_at')->count())->toBe(1);
});

test('the feed pages at 50 with a stable total', function () {
    $me = $this->loginUser();
    for ($i = 0; $i < 55; $i++) {
        seedNotification($me->name, ['subject_id' => 'hyperlight_page_'.$i]);
    }

    $first = $this->getJson('/api/notifications')->assertStatus(200);
    expect($first->json('total'))->toBe(55);
    expect(count($first->json('items')))->toBe(50);

    $second = $this->getJson('/api/notifications?offset=50');
    expect(count($second->json('items')))->toBe(5);
});
