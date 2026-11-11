<?php

/**
 * The commoner score ("hectares of the commons tilled") — credibility earned
 * from USEFUL suggested edits. Positive-sum (accepted/liked only), self-
 * suggestions and anonymous suggesters excluded, recompute-from-state so a
 * revert/reopen/delete un-credits automatically.
 */

use App\Services\Commoner\CommonerScoreService;
use App\Services\Connections\ConnectionRefresher;
use Illuminate\Support\Facades\DB;

beforeEach(function () {
    // Suggestion resolution does not refresh connections, but keep the same
    // guard as the notification tests in case a shared path touches it.
    $this->app->instance(ConnectionRefresher::class, Mockery::mock(ConnectionRefresher::class, function ($mock) {
        $mock->shouldReceive('refresh')->zeroOrMoreTimes()->andReturn([]);
    }));
});

afterEach(fn () => $this->cleanupApiFixtures());

function commonerScoreOf(string $name): int
{
    return (int) DB::connection('pgsql_admin')->table('users')->where('name', $name)->value('commoner_score');
}

/** Seed a resolved suggestion by $suggester on $book (admin connection — commits past RefreshDatabase). */
function seedResolvedSuggestion(string $book, string $hlId, ?string $suggester, string $status, int $nodes = 1): void
{
    $map = [];
    for ($i = 1; $i <= $nodes; $i++) {
        $map[$book.'_n'.$i] = ['before' => 'old '.$i, 'after' => 'new '.$i];
    }
    DB::connection('pgsql_admin')->table('hyperlights')->insert([
        'book' => $book,
        'hyperlight_id' => $hlId,
        'creator' => $suggester,
        'highlightedText' => 'a passage',
        'suggested_text' => json_encode($map),
        'suggestion_status' => $status,
        'raw_json' => json_encode([]),
        'hidden' => false,
        'created_at' => now(),
        'updated_at' => now(),
    ]);
}

/* ─── counting rules (service, direct) ────────────────────────────────── */

test('accepted earns ACCEPTED_HECTARES, liked earns LIKED_HECTARES, rejected nothing', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    $suggester = $this->apiUser();
    $svc = app(CommonerScoreService::class);

    seedResolvedSuggestion($book, 'HL_acc', $suggester->name, 'accepted');
    $svc->recompute([$suggester->name]);
    expect(commonerScoreOf($suggester->name))->toBe(CommonerScoreService::ACCEPTED_HECTARES);

    seedResolvedSuggestion($book, 'HL_like', $suggester->name, 'liked');
    $svc->recompute([$suggester->name]);
    expect(commonerScoreOf($suggester->name))
        ->toBe(CommonerScoreService::ACCEPTED_HECTARES + CommonerScoreService::LIKED_HECTARES);

    seedResolvedSuggestion($book, 'HL_rej', $suggester->name, 'rejected');
    $svc->recompute([$suggester->name]);
    expect(commonerScoreOf($suggester->name))
        ->toBe(CommonerScoreService::ACCEPTED_HECTARES + CommonerScoreService::LIKED_HECTARES);
});

test('a multi-node suggestion counts once (one row = one accept)', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    $suggester = $this->apiUser();

    seedResolvedSuggestion($book, 'HL_multi', $suggester->name, 'accepted', nodes: 3);
    app(CommonerScoreService::class)->recompute([$suggester->name]);

    expect(commonerScoreOf($suggester->name))->toBe(CommonerScoreService::ACCEPTED_HECTARES);
});

test('a SELF-suggestion earns nothing (cannot credential yourself)', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);

    seedResolvedSuggestion($book, 'HL_self', $owner->name, 'accepted'); // creator == book owner
    app(CommonerScoreService::class)->recompute([$owner->name]);

    expect(commonerScoreOf($owner->name))->toBe(0);
});

test('an anonymous suggester earns nothing and does not break the backfill', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    $named = $this->apiUser();

    seedResolvedSuggestion($book, 'HL_anon', null, 'accepted'); // creator NULL
    seedResolvedSuggestion($book, 'HL_named', $named->name, 'accepted');

    // Whole-table backfill — the anon row has no users row to credit.
    app(CommonerScoreService::class)->recompute();

    expect(commonerScoreOf($named->name))->toBe(CommonerScoreService::ACCEPTED_HECTARES);
});

test('recompute is FROM STATE: reverting/reopening un-credits', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    $suggester = $this->apiUser();
    $svc = app(CommonerScoreService::class);

    seedResolvedSuggestion($book, 'HL_revert', $suggester->name, 'accepted');
    $svc->recompute([$suggester->name]);
    expect(commonerScoreOf($suggester->name))->toBe(CommonerScoreService::ACCEPTED_HECTARES);

    // Owner reverts → status back to pending.
    DB::connection('pgsql_admin')->table('hyperlights')
        ->where('book', $book)->where('hyperlight_id', 'HL_revert')
        ->update(['suggestion_status' => 'pending']);
    $svc->recompute([$suggester->name]);
    expect(commonerScoreOf($suggester->name))->toBe(0);
});

/* ─── the endpoint (private own-view) ─────────────────────────────────── */

test('/api/me/commoner returns the caller\'s own breakdown', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    $suggester = $this->loginUser();

    seedResolvedSuggestion($book, 'HL_a', $suggester->name, 'accepted');
    seedResolvedSuggestion($book, 'HL_b', $suggester->name, 'accepted');
    seedResolvedSuggestion($book, 'HL_c', $suggester->name, 'liked');

    $body = $this->getJson('/api/me/commoner')->assertStatus(200)->json();
    expect($body['accepted'])->toBe(2);
    expect($body['liked'])->toBe(1);
    expect($body['hectares'])->toBe(2 * CommonerScoreService::ACCEPTED_HECTARES + CommonerScoreService::LIKED_HECTARES);
});

/* ─── end to end through the resolve endpoint ─────────────────────────── */

test('accepting a suggestion via the endpoint boosts the suggester and notifies them', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public', 'title' => 'Owned']);
    $suggester = $this->apiUser();
    seedResolvedSuggestion($book, 'HL_e2e', $suggester->name, 'pending');

    $this->actingAs($owner);
    $this->postJson('/api/db/hyperlights/suggestion/resolve', [
        'book' => $book, 'hyperlight_id' => 'HL_e2e', 'resolution' => 'accepted',
    ])->assertStatus(200);

    // Score credited (recompute fired on resolution).
    expect(commonerScoreOf($suggester->name))->toBe(CommonerScoreService::ACCEPTED_HECTARES);

    // The suggester was notified.
    $notes = DB::connection('pgsql_admin')->table('notifications')
        ->where('recipient', $suggester->name)->where('type', 'suggestion_accepted')->get();
    expect($notes)->toHaveCount(1);
    expect($notes[0]->actor)->toBe($owner->name);
    expect($notes[0]->subject_id)->toBe('HL_e2e');

    // Reverting un-credits and does NOT notify.
    $this->postJson('/api/db/hyperlights/suggestion/resolve', [
        'book' => $book, 'hyperlight_id' => 'HL_e2e', 'resolution' => 'pending',
    ])->assertStatus(200);
    expect(commonerScoreOf($suggester->name))->toBe(0);
});

test('rejecting is silent — no notification, no hectares', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    $suggester = $this->apiUser();
    seedResolvedSuggestion($book, 'HL_rej2', $suggester->name, 'pending');

    $this->actingAs($owner);
    $this->postJson('/api/db/hyperlights/suggestion/resolve', [
        'book' => $book, 'hyperlight_id' => 'HL_rej2', 'resolution' => 'rejected',
    ])->assertStatus(200);

    expect(commonerScoreOf($suggester->name))->toBe(0);
    expect(DB::connection('pgsql_admin')->table('notifications')
        ->where('recipient', $suggester->name)
        ->whereIn('type', ['suggestion_accepted', 'suggestion_liked'])->count())->toBe(0);
});

test('a self-suggestion resolved on your own book never notifies', function () {
    $owner = $this->loginUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    seedResolvedSuggestion($book, 'HL_selfe2e', $owner->name, 'pending');

    $this->postJson('/api/db/hyperlights/suggestion/resolve', [
        'book' => $book, 'hyperlight_id' => 'HL_selfe2e', 'resolution' => 'accepted',
    ])->assertStatus(200);

    expect(DB::connection('pgsql_admin')->table('notifications')
        ->where('recipient', $owner->name)
        ->whereIn('type', ['suggestion_accepted', 'suggestion_liked'])->count())->toBe(0);
    expect(commonerScoreOf($owner->name))->toBe(0); // self-suggestion excluded
});
