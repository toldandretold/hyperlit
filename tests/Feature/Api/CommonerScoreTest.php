<?php

/**
 * The commoner score ("hectares of the commons tilled") — earned by hosting
 * published books, by others liking and citing them, and by USEFUL suggested
 * edits. Positive-sum, self-credit of every kind excluded, recompute-from-state
 * so a revert/unpublish/unlike un-credits automatically.
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

/** What one suggestion is worth to its SUGGESTER: the "left" credit plus its resolution's weight. */
function acceptedHa(): int
{
    return CommonerScoreService::SUGGESTED_HECTARES + CommonerScoreService::ACCEPTED_HECTARES;
}

function likedHa(): int
{
    return CommonerScoreService::SUGGESTED_HECTARES + CommonerScoreService::LIKED_HECTARES;
}

/* ─── counting rules (service, direct) ────────────────────────────────── */

test('accepted/liked earn their weight on top of the left credit; rejected earns nothing at all', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    $suggester = $this->apiUser();
    $svc = app(CommonerScoreService::class);

    seedResolvedSuggestion($book, 'HL_acc', $suggester->name, 'accepted');
    $svc->recompute([$suggester->name]);
    expect(commonerScoreOf($suggester->name))->toBe(acceptedHa());

    seedResolvedSuggestion($book, 'HL_like', $suggester->name, 'liked');
    $svc->recompute([$suggester->name]);
    expect(commonerScoreOf($suggester->name))
        ->toBe(acceptedHa() + likedHa());

    seedResolvedSuggestion($book, 'HL_rej', $suggester->name, 'rejected');
    $svc->recompute([$suggester->name]);
    expect(commonerScoreOf($suggester->name))
        ->toBe(acceptedHa() + likedHa());
});

test('a multi-node suggestion counts once (one row = one accept)', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    $suggester = $this->apiUser();

    seedResolvedSuggestion($book, 'HL_multi', $suggester->name, 'accepted', nodes: 3);
    app(CommonerScoreService::class)->recompute([$suggester->name]);

    expect(commonerScoreOf($suggester->name))->toBe(acceptedHa());
});

test('a SELF-suggestion earns nothing (cannot credential yourself)', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);

    seedResolvedSuggestion($book, 'HL_self', $owner->name, 'accepted'); // creator == book owner
    app(CommonerScoreService::class)->recompute([$owner->name]);

    // Only the hosting credit for the (public) book — the self-accept adds nothing.
    expect(commonerScoreOf($owner->name))->toBe(CommonerScoreService::HOSTED_HECTARES);
    expect(app(CommonerScoreService::class)->breakdownFor($owner->name)['accepted'])->toBe(0);
});

test('an anonymous suggester earns nothing and does not break the backfill', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    $named = $this->apiUser();

    seedResolvedSuggestion($book, 'HL_anon', null, 'accepted'); // creator NULL
    seedResolvedSuggestion($book, 'HL_named', $named->name, 'accepted');

    // Whole-table backfill — the anon row has no users row to credit.
    app(CommonerScoreService::class)->recompute();

    expect(commonerScoreOf($named->name))->toBe(acceptedHa());
});

test('recompute is FROM STATE: reverting/reopening un-credits', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    $suggester = $this->apiUser();
    $svc = app(CommonerScoreService::class);

    seedResolvedSuggestion($book, 'HL_revert', $suggester->name, 'accepted');
    $svc->recompute([$suggester->name]);
    expect(commonerScoreOf($suggester->name))->toBe(acceptedHa());

    // Owner reverts → status back to pending.
    DB::connection('pgsql_admin')->table('hyperlights')
        ->where('book', $book)->where('hyperlight_id', 'HL_revert')
        ->update(['suggestion_status' => 'pending']);
    $svc->recompute([$suggester->name]);
    // Only the "left" credit survives — a reopened suggestion is still one you left.
    expect(commonerScoreOf($suggester->name))->toBe(CommonerScoreService::SUGGESTED_HECTARES);
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
    expect($body['hectares'])->toBe(2 * acceptedHa() + likedHa());

    // The tillage chart draws from `sources`; its parts must sum to the total.
    $sources = collect($body['sources'])->keyBy('key');
    expect($sources['accepted']['count'])->toBe(2);
    expect($sources['accepted']['per'])->toBe(CommonerScoreService::ACCEPTED_HECTARES);
    expect($sources['liked']['count'])->toBe(1);
    expect($sources['liked']['per'])->toBe(CommonerScoreService::LIKED_HECTARES);
    expect(collect($body['sources'])->sum(fn ($s) => $s['count'] * $s['per']))->toBe($body['hectares']);
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
    expect(commonerScoreOf($suggester->name))->toBe(acceptedHa());

    // The suggester was notified.
    $notes = DB::connection('pgsql_admin')->table('notifications')
        ->where('recipient', $suggester->name)->where('type', 'suggestion_accepted')->get();
    expect($notes)->toHaveCount(1);
    expect($notes[0]->actor)->toBe($owner->name);
    expect($notes[0]->subject_id)->toBe('HL_e2e');

    // The OWNER earned stewardship for accepting it.
    expect(commonerScoreOf($owner->name))->toBe(
        CommonerScoreService::STEWARDED_HECTARES + CommonerScoreService::HOSTED_HECTARES
    );

    // Reverting un-credits the accept (not the "left" credit), un-credits the
    // owner's stewardship, and does NOT notify.
    $this->postJson('/api/db/hyperlights/suggestion/resolve', [
        'book' => $book, 'hyperlight_id' => 'HL_e2e', 'resolution' => 'pending',
    ])->assertStatus(200);
    expect(commonerScoreOf($suggester->name))->toBe(CommonerScoreService::SUGGESTED_HECTARES);
    expect(commonerScoreOf($owner->name))->toBe(CommonerScoreService::HOSTED_HECTARES);
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
    // Self-suggestion excluded: the owner holds only the hosting credit for
    // their own public book, nothing for accepting their own edit.
    expect(commonerScoreOf($owner->name))->toBe(CommonerScoreService::HOSTED_HECTARES);
});

/* ─── hosting, likes and citations ────────────────────────────────────── */

test('every PUBLISHED, content-bearing book you host earns HOSTED_HECTARES — drafts, empties, parts and generated pages do not', function () {
    $owner = $this->apiUser();
    $this->makeBook($owner, ['visibility' => 'public', 'has_nodes' => true]);
    $this->makeBook($owner, ['visibility' => 'public', 'has_nodes' => true]);
    $this->makeBook($owner, ['visibility' => 'private', 'has_nodes' => true]); // draft
    $this->makeBook($owner, ['visibility' => 'public', 'has_nodes' => false]); // empty
    $parent = $this->makeBook($owner, ['visibility' => 'public', 'has_nodes' => true]);
    $this->makeBook($owner, ['book' => $parent.'/Fn1', 'visibility' => 'public', 'has_nodes' => true]); // sub-book

    // Rows the platform generates FOR the user: their profile page books and a
    // shelf render. Not apitest_-prefixed, so cleaned up here.
    $generated = [$owner->name, $owner->name.'About', $owner->name.'_public_title', 'shelf_apitest_'.$owner->id.'_recent'];
    try {
        foreach ($generated as $book) {
            $this->makeBook($owner, ['book' => $book, 'visibility' => 'public', 'has_nodes' => true]);
        }

        $b = app(CommonerScoreService::class)->breakdownFor($owner->name);
        $hosted = collect($b['sources'])->firstWhere('key', 'hosted');
        expect($hosted['count'])->toBe(3);
        expect($b['hectares'])->toBe(3 * CommonerScoreService::HOSTED_HECTARES);
    } finally {
        DB::connection('pgsql_admin')->table('library')->whereIn('book', $generated)->delete();
    }
});

test('unpublishing your only book takes the stored score back to 0', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public', 'has_nodes' => true]);
    $svc = app(CommonerScoreService::class);

    $svc->recompute([$owner->name]);
    expect(commonerScoreOf($owner->name))->toBe(CommonerScoreService::HOSTED_HECTARES);

    DB::connection('pgsql_admin')->table('library')->where('book', $book)->update(['visibility' => 'private']);
    $svc->recompute([$owner->name]);
    expect(commonerScoreOf($owner->name))->toBe(0);
});

test('a like from SOMEONE ELSE earns BOOK_LIKED_HECTARES; liking your own book earns nothing', function () {
    $owner = $this->apiUser();
    $fan = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public', 'has_nodes' => false]); // not hosted: isolates the like

    DB::connection('pgsql_admin')->table('book_likes')->insert([
        ['book' => $book, 'creator' => $fan->name, 'created_at' => now()],
        ['book' => $book, 'creator' => $owner->name, 'created_at' => now()],
    ]);

    $b = app(CommonerScoreService::class)->breakdownFor($owner->name);
    expect(collect($b['sources'])->firstWhere('key', 'book_liked')['count'])->toBe(1);
    expect($b['hectares'])->toBe(CommonerScoreService::BOOK_LIKED_HECTARES);
});

test('being hypercited by ANOTHER user\'s text earns HYPERCITED_HECTARES; citing yourself earns nothing', function () {
    $owner = $this->apiUser();
    $other = $this->apiUser();
    $cited = $this->makeBook($owner, ['visibility' => 'public', 'has_nodes' => true]);
    $ownCiting = $this->makeBook($owner, ['visibility' => 'public', 'has_nodes' => true]);
    $otherCiting = $this->makeBook($other, ['visibility' => 'public', 'has_nodes' => true]);

    foreach ([$otherCiting, $ownCiting] as $citing) {
        DB::connection('pgsql_admin')->table('hypercites')->insert([
            'book' => $cited,
            'hyperciteId' => 'hypercite_'.Illuminate\Support\Str::lower(Illuminate\Support\Str::random(8)),
            'citedIN' => json_encode(["/{$citing}#hypercite_x"]),
            'raw_json' => '{}',
            'charData' => '{}',
            'created_at' => now(),
        ]);
    }

    $b = app(CommonerScoreService::class)->breakdownFor($owner->name);
    $sources = collect($b['sources'])->keyBy('key');
    expect($sources['hypercited']['count'])->toBe(1);
    expect($sources['hosted']['count'])->toBe(2);
    expect($b['hectares'])->toBe(CommonerScoreService::HYPERCITED_HECTARES + 2 * CommonerScoreService::HOSTED_HECTARES);

    // The owner's self-citation earns no citing credit either.
    expect($sources['citing']['count'])->toBe(0);

    // The citer earns CITING (a smaller credit for their own act), never "being cited".
    $citer = collect(app(CommonerScoreService::class)->breakdownFor($other->name)['sources'])->keyBy('key');
    expect($citer['citing']['count'])->toBe(1);
    expect($citer['hypercited']['count'])->toBe(0);
});

test('the stored score and the live breakdown agree (one definition)', function () {
    $owner = $this->apiUser();
    $fan = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public', 'has_nodes' => true]);
    DB::connection('pgsql_admin')->table('book_likes')->insert(['book' => $book, 'creator' => $fan->name, 'created_at' => now()]);
    seedResolvedSuggestion($this->makeBook($fan, ['visibility' => 'public']), 'HL_mix', $owner->name, 'accepted');

    $svc = app(CommonerScoreService::class);
    $svc->recompute();
    expect(commonerScoreOf($owner->name))->toBe($svc->breakdownFor($owner->name)['hectares']);
    expect(commonerScoreOf($owner->name))->toBe(
        CommonerScoreService::HOSTED_HECTARES + CommonerScoreService::BOOK_LIKED_HECTARES + acceptedHa()
    );
});

test('highlights on OTHERS\' books earn; highlights on your own do not; reader-days count per READS_PER_HECTARE', function () {
    $owner = $this->apiUser();
    $reader = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public', 'has_nodes' => true, 'total_views' => 25]);

    foreach ([[$reader->name, 'HL_r1'], [$reader->name, 'HL_r2'], [$owner->name, 'HL_own']] as [$who, $id]) {
        DB::connection('pgsql_admin')->table('hyperlights')->insert([
            'book' => $book, 'hyperlight_id' => $id, 'creator' => $who,
            'highlightedText' => 'x', 'raw_json' => '{}', 'hidden' => false,
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }

    $svc = app(CommonerScoreService::class);
    $readerSources = collect($svc->breakdownFor($reader->name)['sources'])->keyBy('key');
    expect($readerSources['highlighted']['count'])->toBe(2);

    $ownerSources = collect($svc->breakdownFor($owner->name)['sources'])->keyBy('key');
    expect($ownerSources['highlighted']['count'])->toBe(0);
    expect($ownerSources['read']['count'])->toBe(intdiv(25, CommonerScoreService::READS_PER_HECTARE));
});

test('every source belongs to a declared group, and the payload carries the groups', function () {
    $groups = collect(CommonerScoreService::GROUPS)->pluck('key');
    foreach (CommonerScoreService::SOURCES as $src) {
        expect($groups)->toContain($src['group']);
    }
    $owner = $this->apiUser();
    $b = app(CommonerScoreService::class)->breakdownFor($owner->name);
    expect(collect($b['groups'])->pluck('key')->all())->toBe($groups->all());
});

test('a verified OPEN-ACCESS work you host earns the bonus; a verified all-rights-reserved one does not', function () {
    $owner = $this->apiUser();
    $this->makeBook($owner, ['visibility' => 'public', 'has_nodes' => true, 'canonical_match_method' => 'user_verified', 'license' => 'CC-BY-4.0']);
    $this->makeBook($owner, ['visibility' => 'public', 'has_nodes' => true, 'canonical_match_method' => 'user_verified', 'license' => 'All-Rights-Reserved']);
    $this->makeBook($owner, ['visibility' => 'public', 'has_nodes' => true, 'license' => 'CC-BY-4.0']); // open but unverified

    $sources = collect(app(CommonerScoreService::class)->breakdownFor($owner->name)['sources'])->keyBy('key');
    expect($sources['hosted']['count'])->toBe(3);
    expect($sources['verified_oa']['count'])->toBe(1);
});

test('the Hyperlit No-AI default is a user licence, not open access', function () {
    expect(App\Support\Licenses::openAccessCodes())
        ->toContain('CC-BY-4.0', 'CC0', 'PDM', 'Publisher-Open', 'Open-Unspecified')
        ->not->toContain(App\Support\Licenses::DEFAULT_USER, 'All-Rights-Reserved', App\Support\Licenses::UNKNOWN, 'custom');
});

test('works your references resolve to count under Citing others', function () {
    $owner = $this->apiUser();
    $other = $this->apiUser();
    $mine = $this->makeBook($owner, ['visibility' => 'public', 'has_nodes' => true]);
    $theirs = $this->makeBook($other, ['visibility' => 'public', 'has_nodes' => true]);
    DB::connection('pgsql_admin')->table('bibliography')->insert([
        'book' => $mine, 'referenceId' => 'ref_commoner', 'content' => 'their work',
        'foundation_source' => $theirs, 'created_at' => now(),
    ]);
    try {
        $b = app(CommonerScoreService::class)->breakdownFor($owner->name);
        $sources = collect($b['sources'])->keyBy('key');
        expect($sources['referencing']['count'])->toBe(1);
        expect($sources['referencing']['group'])->toBe('citing');
        expect($sources['referenced']['group'])->toBe('citing'); // one activity, both directions
        // …and the cited author is credited as referenced, never the reverse.
        $theirSources = collect(app(CommonerScoreService::class)->breakdownFor($other->name)['sources'])->keyBy('key');
        expect($theirSources['referenced']['count'])->toBe(1);
        expect($theirSources['referencing']['count'])->toBe(0);
    } finally {
        DB::connection('pgsql_admin')->table('bibliography')->where('book', $mine)->delete();
    }
});

test('system accounts never earn, and are left out of the commons total', function () {
    $system = App\Services\CanonicalVersions\AutoVersionResolver::CREATOR;
    $svc = app(CommonerScoreService::class);
    $book = $this->makeBook(null, ['creator' => $system, 'visibility' => 'public', 'has_nodes' => true]);

    expect($svc->counts([$system]))->toBe([]);
    expect($svc->breakdownFor($system)['hectares'])->toBe(0);
});

test('the commons total sums every stored score, aggregate only', function () {
    $a = $this->apiUser();
    $b = $this->apiUser();
    $this->makeBook($a, ['visibility' => 'public', 'has_nodes' => true]);
    $this->makeBook($b, ['visibility' => 'public', 'has_nodes' => true]);
    $this->makeBook($b, ['visibility' => 'public', 'has_nodes' => true]);
    $svc = app(CommonerScoreService::class);

    $before = $svc->commonsTotal();
    $svc->recompute([$a->name, $b->name]);
    $after = $svc->commonsTotal();

    expect($after['hectares'] - $before['hectares'])->toBe(3 * CommonerScoreService::HOSTED_HECTARES);
    expect($after['commoners'] - $before['commoners'])->toBe(2);

    $body = $this->actingAs($a)->getJson('/api/me/commoner')->assertStatus(200)->json();
    expect($body['commons'])->toBe($after);
    expect(array_keys($body['commons']))->toBe(['hectares', 'commoners']);
});

/* ─── the stored snapshot (daily stats, not a live feed) ──────────────── */

test('Stats reads the STORED snapshot: new activity shows after the next recompute, not before', function () {
    $owner = $this->apiUser();
    $fan = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public', 'has_nodes' => true]);
    $svc = app(CommonerScoreService::class);

    $first = $svc->breakdownFor($owner->name); // never computed → computed once, on demand
    expect($first['hectares'])->toBe(CommonerScoreService::HOSTED_HECTARES);
    expect($first['computed_at'])->not->toBeNull();

    DB::connection('pgsql_admin')->table('book_likes')->insert(['book' => $book, 'creator' => $fan->name, 'created_at' => now()]);
    expect($svc->breakdownFor($owner->name)['hectares'])->toBe(CommonerScoreService::HOSTED_HECTARES); // snapshot, unchanged

    $svc->recompute([$owner->name]);
    expect($svc->breakdownFor($owner->name)['hectares'])
        ->toBe(CommonerScoreService::HOSTED_HECTARES + CommonerScoreService::BOOK_LIKED_HECTARES);
});

test('the endpoint serves the snapshot without recounting', function () {
    $owner = $this->loginUser();
    $this->makeBook($owner, ['visibility' => 'public', 'has_nodes' => true]);
    app(CommonerScoreService::class)->recompute([$owner->name]);

    $spy = Mockery::mock(App\Services\Connections\ConnectionCountQuery::class);
    $spy->shouldNotReceive('edgesByCreator');
    $this->app->instance(App\Services\Connections\ConnectionCountQuery::class, $spy);
    $this->app->forgetInstance(CommonerScoreService::class);

    $body = $this->getJson('/api/me/commoner')->assertStatus(200)->json();
    expect($body['hectares'])->toBe(CommonerScoreService::HOSTED_HECTARES);
});

test('recompute stamps a real zero for a user with nothing — computed, not "never computed"', function () {
    $nobody = $this->apiUser();
    app(CommonerScoreService::class)->recompute([$nobody->name]);

    $row = DB::connection('pgsql_admin')->table('users')->where('name', $nobody->name)
        ->first(['commoner_score', 'commoner_breakdown', 'commoner_computed_at']);
    expect((int) $row->commoner_score)->toBe(0);
    expect(json_decode($row->commoner_breakdown, true))->toBe([]);
    expect($row->commoner_computed_at)->not->toBeNull();
});

test('a stored breakdown is re-weighted at read time (counts are stored, weights are not)', function () {
    $owner = $this->apiUser();
    DB::connection('pgsql_admin')->table('users')->where('name', $owner->name)->update([
        'commoner_breakdown' => json_encode(['hosted' => 4, 'hypercited' => 1]),
        'commoner_computed_at' => now(),
    ]);

    $b = app(CommonerScoreService::class)->breakdownFor($owner->name);
    expect($b['hectares'])->toBe(4 * CommonerScoreService::HOSTED_HECTARES + CommonerScoreService::HYPERCITED_HECTARES);
});

test('a deleted account\'s tombstone row is never credited, even if it still owns public books', function () {
    $gone = $this->apiUser();
    $this->makeBook($gone, ['visibility' => 'public', 'has_nodes' => true]);
    DB::connection('pgsql_admin')->table('users')->where('id', $gone->id)
        ->update(['status' => 'deleted', 'commoner_breakdown' => null, 'commoner_computed_at' => null]);

    app(CommonerScoreService::class)->recompute([$gone->name]);
    $row = DB::connection('pgsql_admin')->table('users')->where('id', $gone->id)->first(['commoner_score', 'commoner_breakdown']);
    expect((int) $row->commoner_score)->toBe(0);
    expect($row->commoner_breakdown)->toBeNull();
});

test('others\' highlights on YOUR books earn HIGHLIGHTED_BY — never your own, an owner-hidden one, or a PRIVATE one', function () {
    $owner = $this->apiUser();
    $reader = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public', 'has_nodes' => false]);
    $hl = function (string $id, string $who, bool $hidden = false) use ($book) {
        DB::connection('pgsql_admin')->table('hyperlights')->insert([
            'book' => $book, 'hyperlight_id' => $id, 'creator' => $who,
            'highlightedText' => 'x', 'raw_json' => '{}', 'hidden' => $hidden,
            'created_at' => now(), 'updated_at' => now(),
        ]);
    };
    $hl('HL_pub', $reader->name);
    $hl('HL_hidden', $reader->name, hidden: true);
    $hl('HL_private', $reader->name);
    $hl('HL_mine', $owner->name);
    // The private highlight's annotation sub-book row — derived id, column unstamped
    // (the fail-closed case the RLS policy covers).
    $this->makeBook($reader, ['book' => $book.'/HL_private', 'visibility' => 'private']);

    $sources = collect(app(CommonerScoreService::class)->breakdownFor($owner->name)['sources'])->keyBy('key');
    expect($sources['highlighted_by']['count'])->toBe(1);
    expect($sources['highlighted_by']['group'])->toBe('annotating');
});
