<?php

/**
 * Recipient controls on the notification WRITE side
 * (NotificationWriter::allowed) and the endpoints that set them:
 * per-type toggles, the anonymous switch, muted actors, the per-actor flood
 * cap, and POST/DELETE /api/notifications/mute.
 *
 * Writer calls are made directly (the trigger endpoints are covered by
 * NotificationTriggerTest); rows are written via pgsql_admin and COMMIT, so
 * cleanupApiFixtures removes them by recipient.
 */

use App\Services\Notifications\NotificationWriter;
use Illuminate\Support\Facades\DB;

afterEach(fn () => $this->cleanupApiFixtures());

function prefNotifs(string $recipient)
{
    return DB::connection('pgsql_admin')->table('notifications')
        ->where('recipient', $recipient)
        ->orderBy('id')
        ->get();
}

function setPrefs(string $name, array $prefs): void
{
    DB::connection('pgsql_admin')->table('users')
        ->where('name', $name)
        ->update(['preferences' => json_encode($prefs)]);
}

function readPrefs(string $name): array
{
    $raw = DB::connection('pgsql_admin')->table('users')->where('name', $name)->value('preferences');

    return $raw ? json_decode($raw, true) : [];
}

function seedNotif(string $recipient, ?string $actor, string $book, string $subject, string $type = 'hyperlight', array $extra = []): void
{
    DB::connection('pgsql_admin')->table('notifications')->insert(array_merge([
        'recipient' => $recipient,
        'actor' => $actor,
        'type' => $type,
        'book' => $book,
        'root_book' => $book,
        'subject_id' => $subject,
        'data' => json_encode(['context_label' => 'your book']),
        'created_at' => now(),
    ], $extra));
}

/* ─── defaults ────────────────────────────────────────────────────── */

test('with no preferences every type still notifies (absent = on)', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    $actor = $this->apiUser();

    NotificationWriter::hyperlightCreated($actor->name, $book, 'hyperlight_d1', 'x');
    NotificationWriter::hyperlightCreated(null, $book, 'hyperlight_d2', 'x');
    NotificationWriter::bookLiked($actor->name, $book);

    expect(prefNotifs($owner->name))->toHaveCount(3);
});

/* ─── per-type toggles ────────────────────────────────────────────── */

test('notify_hyperlight=false suppresses highlights and nothing else', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    $actor = $this->apiUser();
    setPrefs($owner->name, ['notify_hyperlight' => false]);

    NotificationWriter::hyperlightCreated($actor->name, $book, 'hyperlight_t1', 'x');
    NotificationWriter::bookLiked($actor->name, $book);
    NotificationWriter::suggestedEdit($actor->name, $book, 'hyperlight_t2', 'my edit');

    expect(prefNotifs($owner->name)->pluck('type')->sort()->values()->all())->toBe(['like', 'suggested_edit']);
});

test('notify_like=false suppresses likes only', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    $actor = $this->apiUser();
    setPrefs($owner->name, ['notify_like' => false]);

    NotificationWriter::bookLiked($actor->name, $book);
    NotificationWriter::hyperlightCreated($actor->name, $book, 'hyperlight_l1', 'x');

    expect(prefNotifs($owner->name)->pluck('type')->all())->toBe(['hyperlight']);
});

test('a suppressed suggested edit does NOT retract the existing highlight notice', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    $actor = $this->apiUser();

    NotificationWriter::hyperlightCreated($actor->name, $book, 'hyperlight_s1', 'x');
    setPrefs($owner->name, ['notify_suggested_edit' => false]);
    NotificationWriter::suggestedEdit($actor->name, $book, 'hyperlight_s1', 'my edit');

    $rows = prefNotifs($owner->name);
    expect($rows)->toHaveCount(1);
    expect($rows[0]->type)->toBe('hyperlight');
});

test('an allowed suggested edit still replaces the highlight notice', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    $actor = $this->apiUser();

    NotificationWriter::hyperlightCreated($actor->name, $book, 'hyperlight_s2', 'x');
    NotificationWriter::suggestedEdit($actor->name, $book, 'hyperlight_s2', 'my edit');

    expect(prefNotifs($owner->name)->pluck('type')->all())->toBe(['suggested_edit']);
});

/* ─── anonymous ───────────────────────────────────────────────────── */

test('notify_anonymous=false suppresses NULL actors only', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    $actor = $this->apiUser();
    setPrefs($owner->name, ['notify_anonymous' => false]);

    NotificationWriter::hyperlightCreated(null, $book, 'hyperlight_a1', 'x');
    NotificationWriter::suggestedEdit(null, $book, 'hyperlight_a2', 'anon text');
    NotificationWriter::hyperlightCreated($actor->name, $book, 'hyperlight_a3', 'x');

    $rows = prefNotifs($owner->name);
    expect($rows)->toHaveCount(1);
    expect($rows[0]->actor)->toBe($actor->name);
});

/* ─── muted actors ────────────────────────────────────────────────── */

test('a muted actor is suppressed while others still notify', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    $muted = $this->apiUser();
    $other = $this->apiUser();
    setPrefs($owner->name, ['notify_muted' => [$muted->name]]);

    NotificationWriter::hyperlightCreated($muted->name, $book, 'hyperlight_m1', 'x');
    NotificationWriter::bookLiked($muted->name, $book);
    NotificationWriter::hyperlightCreated($other->name, $book, 'hyperlight_m2', 'x');

    $rows = prefNotifs($owner->name);
    expect($rows)->toHaveCount(1);
    expect($rows[0]->actor)->toBe($other->name);
});

test('the terms notice ignores every preference', function () {
    $owner = $this->apiUser();
    setPrefs($owner->name, [
        'notify_hyperlight' => false, 'notify_suggested_edit' => false,
        'notify_hypercite' => false, 'notify_like' => false,
        'notify_anonymous' => false, 'notify_muted' => ['Hyperlit'],
    ]);

    NotificationWriter::termsPublished($owner->name, 'v-test-'.uniqid(), 'its Terms of Service');

    expect(prefNotifs($owner->name)->pluck('type')->all())->toBe(['terms_published']);
});

/* ─── flood cap ───────────────────────────────────────────────────── */

test('the flood cap drops an actor past the hourly limit, and only that actor', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    $flooder = $this->apiUser();
    $other = $this->apiUser();

    for ($i = 0; $i < NotificationWriter::FLOOD_CAP_PER_HOUR; $i++) {
        seedNotif($owner->name, $flooder->name, $book, "hyperlight_f{$i}");
    }

    NotificationWriter::hyperlightCreated($flooder->name, $book, 'hyperlight_over', 'x');
    NotificationWriter::hyperlightCreated($other->name, $book, 'hyperlight_fine', 'x');

    $rows = prefNotifs($owner->name);
    expect($rows)->toHaveCount(NotificationWriter::FLOOD_CAP_PER_HOUR + 1);
    expect($rows->pluck('subject_id'))->not->toContain('hyperlight_over');
    expect($rows->pluck('subject_id'))->toContain('hyperlight_fine');
});

test('rows older than an hour do not count toward the flood cap', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    $actor = $this->apiUser();

    for ($i = 0; $i < NotificationWriter::FLOOD_CAP_PER_HOUR; $i++) {
        seedNotif($owner->name, $actor->name, $book, "hyperlight_old{$i}", 'hyperlight', ['created_at' => now()->subHours(2)]);
    }

    NotificationWriter::hyperlightCreated($actor->name, $book, 'hyperlight_new', 'x');

    expect(prefNotifs($owner->name)->pluck('subject_id'))->toContain('hyperlight_new');
});

test('the flood cap meters anonymous actors as one group', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);

    for ($i = 0; $i < NotificationWriter::FLOOD_CAP_PER_HOUR; $i++) {
        seedNotif($owner->name, null, $book, "hyperlight_anon{$i}");
    }

    NotificationWriter::hyperlightCreated(null, $book, 'hyperlight_anon_over', 'x');

    expect(prefNotifs($owner->name)->pluck('subject_id'))->not->toContain('hyperlight_anon_over');
});

/* ─── mute / unmute endpoints ─────────────────────────────────────── */

test('muting an actor stores them and deletes only your rows from them', function () {
    $owner = $this->loginUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    $actor = $this->apiUser();
    $other = $this->apiUser();
    $bystander = $this->apiUser();
    seedNotif($owner->name, $actor->name, $book, 'hyperlight_x1');
    seedNotif($owner->name, $actor->name, $book, 'hyperlight_x2');
    seedNotif($owner->name, $other->name, $book, 'hyperlight_x3');
    seedNotif($bystander->name, $actor->name, $book, 'hyperlight_x4');

    $this->postJson('/api/notifications/mute', ['actor' => $actor->name])
        ->assertStatus(200)
        ->assertJsonPath('muted', [$actor->name])
        ->assertJsonPath('deleted', 2);

    expect(readPrefs($owner->name)['notify_muted'])->toBe([$actor->name]);
    // The deletes ran on the default connection inside the test transaction,
    // so read back through it (the admin connection can't see uncommitted deletes).
    expect(DB::table('notifications')->where('actor', $actor->name)->count())->toBe(0);
    expect(DB::table('notifications')->where('actor', $other->name)->count())->toBe(1);
    expect(prefNotifs($bystander->name))->toHaveCount(1);
});

test('you cannot mute someone who never notified you (no username probing)', function () {
    $this->loginUser();
    $stranger = $this->apiUser();

    $this->assertApiError($this->postJson('/api/notifications/mute', ['actor' => $stranger->name]), 422);
    $this->assertApiError($this->postJson('/api/notifications/mute', ['actor' => '']), 422);
});

test('muting keeps existing preferences, and unmuting removes the actor', function () {
    $owner = $this->loginUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    $actor = $this->apiUser();
    setPrefs($owner->name, ['theme' => 'dark', 'notify_like' => false]);
    seedNotif($owner->name, $actor->name, $book, 'hyperlight_u1');

    $this->postJson('/api/notifications/mute', ['actor' => $actor->name])->assertStatus(200);
    expect(readPrefs($owner->name))->toMatchArray(['theme' => 'dark', 'notify_like' => false, 'notify_muted' => [$actor->name]]);

    $this->deleteJson('/api/notifications/mute', ['actor' => $actor->name])
        ->assertStatus(200)
        ->assertJsonPath('muted', []);
    $prefs = readPrefs($owner->name);
    expect($prefs)->not->toHaveKey('notify_muted');
    expect($prefs)->toMatchArray(['theme' => 'dark', 'notify_like' => false]);
});

test('mute endpoints require a login', function () {
    $this->assertApiError($this->postJson('/api/notifications/mute', ['actor' => 'someone']), 401);
    $this->assertApiError($this->deleteJson('/api/notifications/mute', ['actor' => 'someone']), 401);
});

/* ─── preferences endpoint ────────────────────────────────────────── */

test('the generic preferences endpoint accepts notify toggles but cannot write the mute list', function () {
    $owner = $this->loginUser();

    $this->postJson('/api/user/preferences', [
        'notify_hyperlight' => false,
        'notify_anonymous' => false,
        'notify_muted' => ['planted'],
    ])->assertStatus(200);

    $prefs = readPrefs($owner->name);
    expect($prefs['notify_hyperlight'])->toBeFalse();
    expect($prefs['notify_anonymous'])->toBeFalse();
    expect($prefs)->not->toHaveKey('notify_muted');
});

test('non-boolean notify values are rejected', function () {
    $owner = $this->loginUser();

    $this->assertApiError($this->postJson('/api/user/preferences', ['notify_like' => 'no']), 422);
    $this->assertApiError($this->postJson('/api/user/preferences', ['notify_anonymous' => 0]), 422);

    expect(readPrefs($owner->name))->not->toHaveKey('notify_like');
});
